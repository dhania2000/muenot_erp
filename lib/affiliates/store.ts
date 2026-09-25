import "server-only"

/**
 * Spec30 (#173) — Affiliate tracking persistence.
 * ---------------------------------------------------------------------------
 * Built on the Spec29 partner subsystem, not beside it:
 *  - an affiliate IS a platform partner; portal access is a partner membership
 *  - a credited signup becomes a normal `platform_partner_referrals` row
 *    (source 'affiliate'), so the existing one-active-attribution-per-tenant
 *    index prevents duplicate credit across links, codes and manual attribution
 *  - commissions come from the existing settlement/clawback ledger
 * This module adds tracked links, clicks, the conversion lifecycle and payouts.
 * All tables are platform-owned; the portal is pinned to the partner resolved
 * from the caller's active membership, never to request input.
 */

import { query, withTransaction } from "@/lib/db"
import { ensurePartnerSchema, getPartner, resolvePartnerForUser } from "@/lib/partners/store"
import { PartnerError, commissionCents, dayOf, fromCents, generateReferralCode, normalizeReferralCode, toCents } from "@/lib/partners/model"
import {
  MAX_LINKS_PER_PARTNER,
  advanceConversion,
  assertPayoutTransition,
  attributionDays,
  commissionTotals,
  decideTouch,
  detectSelfReferral,
  evaluateClick,
  newClickToken,
  parseClickCookie,
  sameHash,
  sha256,
  signClickCookie,
  toSqlDateTime,
  touchPolicy,
  type ConversionRow,
  type ConversionState,
  type PayoutStatus,
  type SelfReferralReason,
} from "@/lib/affiliates/model"

type Conn = { query: (sql: string, params?: any[]) => Promise<any> }
const rowsOf = async (conn: Conn, sql: string, params: any[] = []): Promise<any[]> =>
  ((await conn.query(sql, params)) as any)?.[0] ?? []
const isDup = (err: unknown) => (err as { code?: string })?.code === "ER_DUP_ENTRY"

export function clickSecret(): string {
  return process.env.SESSION_SECRET || ""
}

let ensured: Promise<void> | null = null

export function ensureAffiliateSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

async function runEnsure(): Promise<void> {
  await ensurePartnerSchema()
  await query(`CREATE TABLE IF NOT EXISTS \`platform_affiliate_links\` (
    \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`partner_id\` INT UNSIGNED NOT NULL,
    \`code\` VARCHAR(16) NOT NULL,
    \`label\` VARCHAR(80) DEFAULT NULL,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'active',
    \`idempotency_key\` VARCHAR(100) DEFAULT NULL,
    \`created_by\` INT UNSIGNED DEFAULT NULL,
    \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_aff_link_code\` (\`code\`),
    UNIQUE KEY \`uniq_aff_link_idem\` (\`idempotency_key\`),
    KEY \`idx_aff_link_partner\` (\`partner_id\`, \`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`platform_affiliate_clicks\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`link_id\` INT UNSIGNED NOT NULL,
    \`partner_id\` INT UNSIGNED NOT NULL,
    \`token_hash\` CHAR(64) NOT NULL,
    \`ip_hash\` CHAR(64) DEFAULT NULL,
    \`ua_hash\` CHAR(64) DEFAULT NULL,
    \`created_at\` DATETIME NOT NULL,
    \`expires_at\` DATETIME NOT NULL,
    \`consumed_at\` DATETIME DEFAULT NULL,
    \`consumed_tenant_id\` INT UNSIGNED DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_aff_click_token\` (\`token_hash\`),
    KEY \`idx_aff_click_link\` (\`link_id\`, \`created_at\`),
    KEY \`idx_aff_click_partner\` (\`partner_id\`, \`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`platform_affiliate_conversions\` (
    \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`partner_id\` INT UNSIGNED NOT NULL,
    \`link_id\` INT UNSIGNED DEFAULT NULL,
    \`click_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`rejected_click_id\` BIGINT UNSIGNED DEFAULT NULL,
    \`tenant_id\` INT UNSIGNED NOT NULL,
    \`referral_id\` INT UNSIGNED DEFAULT NULL,
    \`state\` VARCHAR(16) NOT NULL DEFAULT 'referred',
    \`reject_reason\` VARCHAR(40) DEFAULT NULL,
    \`referred_at\` DATETIME NOT NULL,
    \`trial_at\` DATETIME DEFAULT NULL,
    \`converted_at\` DATETIME DEFAULT NULL,
    \`paid_at\` DATETIME DEFAULT NULL,
    \`first_paid_invoice_id\` INT UNSIGNED DEFAULT NULL,
    \`cancelled_at\` DATETIME DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_aff_conv_tenant\` (\`tenant_id\`),
    UNIQUE KEY \`uniq_aff_conv_click\` (\`click_id\`),
    KEY \`idx_aff_conv_partner\` (\`partner_id\`, \`state\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`platform_affiliate_payouts\` (
    \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`partner_id\` INT UNSIGNED NOT NULL,
    \`currency\` VARCHAR(10) NOT NULL,
    \`amount\` DECIMAL(12,2) NOT NULL,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending',
    \`reference\` VARCHAR(120) DEFAULT NULL,
    \`void_reason\` VARCHAR(300) DEFAULT NULL,
    \`idempotency_key\` VARCHAR(100) NOT NULL,
    \`created_by\` INT UNSIGNED DEFAULT NULL,
    \`created_at\` DATETIME NOT NULL,
    \`paid_by\` INT UNSIGNED DEFAULT NULL,
    \`paid_at\` DATETIME DEFAULT NULL,
    \`voided_by\` INT UNSIGNED DEFAULT NULL,
    \`voided_at\` DATETIME DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_aff_payout_idem\` (\`idempotency_key\`),
    KEY \`idx_aff_payout_partner\` (\`partner_id\`, \`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`platform_affiliate_payout_items\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`payout_id\` INT UNSIGNED NOT NULL,
    \`commission_id\` BIGINT UNSIGNED NOT NULL,
    \`amount\` DECIMAL(12,2) NOT NULL,
    \`released\` TINYINT(1) NOT NULL DEFAULT 0,
    \`active_commission_id\` BIGINT UNSIGNED AS (IF(\`released\` = 0, \`commission_id\`, NULL)) STORED,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_aff_payout_item_active\` (\`active_commission_id\`),
    KEY \`idx_aff_payout_item_payout\` (\`payout_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type AffiliateLink = {
  id: number
  partnerId: number
  code: string
  label: string | null
  status: "active" | "disabled"
  createdAt: string | null
  clicks?: number
  signups?: number
}

function mapLink(r: any): AffiliateLink {
  return {
    id: Number(r.id),
    partnerId: Number(r.partner_id),
    code: r.code,
    label: r.label ?? null,
    status: r.status === "active" ? "active" : "disabled",
    createdAt: dayOf(r.created_at),
    ...(r.clicks !== undefined ? { clicks: Number(r.clicks) } : {}),
    ...(r.signups !== undefined ? { signups: Number(r.signups) } : {}),
  }
}

export async function createLink(input: { partnerId: number; label: string | null; actorUserId: number; idempotencyKey: string | null }) {
  await ensureAffiliateSchema()
  const replay = async () => {
    if (!input.idempotencyKey) return null
    const rows = await query<any[]>("SELECT * FROM `platform_affiliate_links` WHERE `idempotency_key` = ? LIMIT 1", [input.idempotencyKey])
    if (!rows[0]) return null
    if (Number(rows[0].partner_id) !== input.partnerId) {
      throw new PartnerError("Idempotency-Key was already used for another partner", "IDEMPOTENCY_CONFLICT", 409)
    }
    return { link: mapLink(rows[0]), replayed: true }
  }
  const prior = await replay()
  if (prior) return prior

  const partner = await getPartner(input.partnerId)
  if (partner.status !== "active") throw new PartnerError("Partner is not active", "PARTNER_INACTIVE", 409)
  const count = await query<any[]>(
    "SELECT COUNT(*) AS c FROM `platform_affiliate_links` WHERE `partner_id` = ? AND `status` = 'active'",
    [input.partnerId],
  )
  if (Number(count[0]?.c ?? 0) >= MAX_LINKS_PER_PARTNER) {
    throw new PartnerError(`At most ${MAX_LINKS_PER_PARTNER} active links per affiliate`, "LINK_LIMIT", 409)
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode()
    try {
      const res: any = await query(
        "INSERT INTO `platform_affiliate_links` (`partner_id`, `code`, `label`, `status`, `idempotency_key`, `created_by`) VALUES (?, ?, ?, 'active', ?, ?)",
        [input.partnerId, code, input.label, input.idempotencyKey, input.actorUserId],
      )
      return {
        link: { id: Number(res.insertId), partnerId: input.partnerId, code, label: input.label, status: "active" as const, createdAt: null },
        replayed: false,
      }
    } catch (err) {
      if (!isDup(err)) throw err
      const concurrent = await replay()
      if (concurrent) return concurrent
    }
  }
  throw new PartnerError("Could not allocate a unique link code; retry", "CODE_COLLISION", 503)
}

export async function listLinks(partnerId: number): Promise<AffiliateLink[]> {
  await ensureAffiliateSchema()
  const rows = await query<any[]>(
    `SELECT l.*,
            (SELECT COUNT(*) FROM \`platform_affiliate_clicks\` c WHERE c.link_id = l.id) AS clicks,
            (SELECT COUNT(*) FROM \`platform_affiliate_conversions\` v WHERE v.link_id = l.id AND v.state <> 'rejected') AS signups
       FROM \`platform_affiliate_links\` l
      WHERE l.partner_id = ?
      ORDER BY l.id DESC LIMIT 200`,
    [partnerId],
  )
  return rows.map(mapLink)
}

/**
 * Enable/disable a link. `scopePartnerId` pins the lookup to the caller's own
 * partner (portal); another partner's link is reported as not found.
 */
export async function setLinkStatus(linkId: number, status: "active" | "disabled", scopePartnerId: number | null) {
  await ensureAffiliateSchema()
  const rows = await query<any[]>("SELECT * FROM `platform_affiliate_links` WHERE `id` = ? LIMIT 1", [linkId])
  const row = rows[0]
  if (!row || (scopePartnerId != null && Number(row.partner_id) !== scopePartnerId)) {
    throw new PartnerError("Link not found", "NOT_FOUND", 404)
  }
  const link = mapLink(row)
  if (link.status === status) return { link, replayed: true }
  await query("UPDATE `platform_affiliate_links` SET `status` = ? WHERE `id` = ?", [status, linkId])
  return { link: { ...link, status }, replayed: false, previous: link.status }
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

async function loadClick(clickId: number, token: string) {
  const rows = await query<any[]>(
    "SELECT `id`, `link_id`, `token_hash`, `expires_at`, `consumed_at` FROM `platform_affiliate_clicks` WHERE `id` = ? LIMIT 1",
    [clickId],
  )
  const r = rows[0]
  if (!r || !sameHash(r.token_hash, sha256(token))) return null
  return { linkId: Number(r.link_id), expiresAt: String(r.expires_at), consumed: r.consumed_at != null }
}

/**
 * Record a click on /r/<code>. Unknown or inactive codes return null (the
 * caller redirects anyway, revealing nothing). Applies the multi-touch policy
 * against a verified existing cookie; a forged cookie counts as "no cookie".
 */
export async function recordClick(input: {
  code: unknown
  existingCookie: string | null
  ipHash: string | null
  uaHash: string | null
  now: Date
}): Promise<{ decision: "new" | "reuse" | "keep"; cookie: { value: string; maxAge: number } | null } | null> {
  const code = normalizeReferralCode(input.code)
  if (!code) return null
  await ensureAffiliateSchema()
  const links = await query<any[]>(
    `SELECT l.id, l.partner_id FROM \`platform_affiliate_links\` l
       JOIN \`platform_partners\` p ON p.id = l.partner_id
      WHERE l.code = ? AND l.status = 'active' AND p.status = 'active' LIMIT 1`,
    [code],
  )
  if (!links[0]) return null
  const linkId = Number(links[0].id)
  const partnerId = Number(links[0].partner_id)
  const secret = clickSecret()

  const parsed = parseClickCookie(input.existingCookie, secret)
  const existing = parsed ? await loadClick(parsed.clickId, parsed.token) : null
  const decision = decideTouch(existing, linkId, touchPolicy(), input.now)
  if (decision !== "new") return { decision, cookie: null }

  const days = attributionDays()
  const token = newClickToken()
  const expires = new Date(input.now.getTime() + days * 86_400_000)
  const res: any = await query(
    `INSERT INTO \`platform_affiliate_clicks\` (\`link_id\`, \`partner_id\`, \`token_hash\`, \`ip_hash\`, \`ua_hash\`, \`created_at\`, \`expires_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [linkId, partnerId, sha256(token), input.ipHash, input.uaHash, toSqlDateTime(input.now), toSqlDateTime(expires)],
  )
  return { decision, cookie: { value: signClickCookie(Number(res.insertId), token, secret), maxAge: days * 86_400 } }
}

// ---------------------------------------------------------------------------
// Signup attribution
// ---------------------------------------------------------------------------

export type ClaimResult =
  | { status: "none" }
  | { status: "attributed"; partnerId: number; linkId: number; clickId: number; referralId: number }
  | { status: "rejected"; partnerId: number; clickId: number; reason: string }

async function partnerMembers(q: (sql: string, p?: any[]) => Promise<any[]>, partnerId: number) {
  const rows = await q(
    `SELECT m.user_id, u.email FROM \`platform_partner_members\` m
       LEFT JOIN \`users\` u ON u.id = m.user_id
      WHERE m.partner_id = ?`,
    [partnerId],
  )
  return rows.map((r) => ({ userId: Number(r.user_id), email: r.email ?? null }))
}

/**
 * Credit a new tenant to the affiliate click in the signup request's cookie.
 * Runs under a row lock on the click, so one click credits at most one tenant.
 * Every refusal after the cookie verifies is persisted (state 'rejected') for
 * audit; a self-referral also burns the click.
 */
export async function claimSignup(input: {
  cookieValue: string | null
  tenantId: number
  registrant: { userId: number; email: string }
  sessionUserId: number | null
  now: Date
}): Promise<ClaimResult> {
  const parsed = parseClickCookie(input.cookieValue, clickSecret())
  if (!parsed) return { status: "none" }
  await ensureAffiliateSchema()
  const at = toSqlDateTime(input.now)

  return withTransaction(async (conn: Conn) => {
    const q = (sql: string, p: any[] = []) => rowsOf(conn, sql, p)
    const rows = await q(
      `SELECT c.*, l.status AS link_status, p.status AS partner_status, p.contact_email
         FROM \`platform_affiliate_clicks\` c
         JOIN \`platform_affiliate_links\` l ON l.id = c.link_id
         JOIN \`platform_partners\` p ON p.id = c.partner_id
        WHERE c.id = ? FOR UPDATE`,
      [parsed.clickId],
    )
    const r = rows[0]
    if (!r || !sameHash(r.token_hash, sha256(parsed.token))) return { status: "none" } as const
    const click = {
      id: Number(r.id),
      linkId: Number(r.link_id),
      partnerId: Number(r.partner_id),
      tokenHash: r.token_hash,
      expiresAt: String(r.expires_at),
      consumedAt: r.consumed_at == null ? null : String(r.consumed_at),
      linkStatus: r.link_status,
      partnerStatus: r.partner_status,
    }

    const reject = async (reason: string, burn: boolean): Promise<ClaimResult> => {
      if (burn) {
        await conn.query(
          "UPDATE `platform_affiliate_clicks` SET `consumed_at` = ?, `consumed_tenant_id` = ? WHERE `id` = ? AND `consumed_at` IS NULL",
          [at, input.tenantId, click.id],
        )
      }
      await conn.query(
        `INSERT IGNORE INTO \`platform_affiliate_conversions\`
           (\`partner_id\`, \`link_id\`, \`rejected_click_id\`, \`tenant_id\`, \`state\`, \`reject_reason\`, \`referred_at\`)
         VALUES (?, ?, ?, ?, 'rejected', ?, ?)`,
        [click.partnerId, click.linkId, click.id, input.tenantId, reason, at],
      )
      return { status: "rejected", partnerId: click.partnerId, clickId: click.id, reason }
    }

    const invalid = evaluateClick(click, input.now)
    if (invalid) return reject(invalid, false)

    const self = detectSelfReferral({
      registrantEmail: input.registrant.email,
      sessionUserId: input.sessionUserId,
      partnerContactEmail: r.contact_email ?? null,
      members: await partnerMembers(q, click.partnerId),
    })
    if (self) return reject(self, true)

    const active = await q(
      "SELECT `id` FROM `platform_partner_referrals` WHERE `tenant_id` = ? AND `status` = 'active' FOR UPDATE",
      [input.tenantId],
    )
    if (active[0]) return reject("already_attributed", false)

    const [ref]: any = await conn.query(
      `INSERT INTO \`platform_partner_referrals\` (\`partner_id\`, \`tenant_id\`, \`ownership\`, \`source\`, \`status\`, \`attributed_at\`, \`created_by\`)
       VALUES (?, ?, 'platform', 'affiliate', 'active', ?, ?)`,
      [click.partnerId, input.tenantId, at, input.registrant.userId],
    )
    const referralId = Number(ref.insertId)
    const [upd]: any = await conn.query(
      "UPDATE `platform_affiliate_clicks` SET `consumed_at` = ?, `consumed_tenant_id` = ? WHERE `id` = ? AND `consumed_at` IS NULL",
      [at, input.tenantId, click.id],
    )
    if (Number(upd?.affectedRows ?? 0) !== 1) throw new PartnerError("Click was consumed concurrently", "CLICK_CONSUMED", 409)
    await conn.query(
      `INSERT INTO \`platform_affiliate_conversions\`
         (\`partner_id\`, \`link_id\`, \`click_id\`, \`tenant_id\`, \`referral_id\`, \`state\`, \`referred_at\`)
       VALUES (?, ?, ?, ?, ?, 'referred', ?)`,
      [click.partnerId, click.linkId, click.id, input.tenantId, referralId, at],
    )
    return { status: "attributed", partnerId: click.partnerId, linkId: click.linkId, clickId: click.id, referralId }
  })
}

/**
 * Self-referral guard for the Spec29 `?ref=<partner code>` path, so the same
 * protection applies whether a signup arrives by tracked link or typed code.
 * Returns the resolved partner and a rejection reason (null when allowed).
 */
export async function checkPartnerCodeSignup(input: {
  rawCode: unknown
  registrantEmail: string
  sessionUserId: number | null
}): Promise<{ partnerId: number; reason: SelfReferralReason | null } | null> {
  const code = normalizeReferralCode(input.rawCode)
  if (!code) return null
  await ensureAffiliateSchema()
  const rows = await query<any[]>(
    "SELECT `id`, `contact_email` FROM `platform_partners` WHERE `referral_code` = ? AND `status` = 'active' LIMIT 1",
    [code],
  )
  if (!rows[0]) return null
  const partnerId = Number(rows[0].id)
  const reason = detectSelfReferral({
    registrantEmail: input.registrantEmail,
    sessionUserId: input.sessionUserId,
    partnerContactEmail: rows[0].contact_email ?? null,
    members: await partnerMembers((sql, p) => query<any[]>(sql, p), partnerId),
  })
  return { partnerId, reason }
}

/** Start lifecycle tracking for a code-based (non-link) referral. */
export async function recordCodeConversion(input: { partnerId: number; tenantId: number; referralId: number; now: Date }) {
  await ensureAffiliateSchema()
  await query(
    `INSERT IGNORE INTO \`platform_affiliate_conversions\` (\`partner_id\`, \`tenant_id\`, \`referral_id\`, \`state\`, \`referred_at\`)
     VALUES (?, ?, ?, 'referred', ?)`,
    [input.partnerId, input.tenantId, input.referralId, toSqlDateTime(input.now)],
  )
}

// ---------------------------------------------------------------------------
// Conversion lifecycle
// ---------------------------------------------------------------------------

/**
 * Advance non-terminal conversions from the existing subscription, invoice and
 * referral records. Optimistic (`WHERE state = <read state>`), so concurrent
 * runs never regress a row. Optionally scoped to one partner.
 */
export async function syncConversions(partnerId: number | null, now: Date) {
  await ensureAffiliateSchema()
  const rows = await query<any[]>(
    `SELECT v.id, v.state, v.trial_at, v.converted_at, v.paid_at, v.first_paid_invoice_id, v.cancelled_at,
            s.status AS sub_status, s.mrr, r.status AS referral_status,
            (SELECT i.id FROM \`platform_invoices\` i WHERE i.tenant_id = v.tenant_id AND i.status = 'paid' AND i.paid_at IS NOT NULL
              ORDER BY i.paid_at ASC, i.id ASC LIMIT 1) AS paid_invoice_id,
            (SELECT i.paid_at FROM \`platform_invoices\` i WHERE i.tenant_id = v.tenant_id AND i.status = 'paid' AND i.paid_at IS NOT NULL
              ORDER BY i.paid_at ASC, i.id ASC LIMIT 1) AS paid_invoice_at
       FROM \`platform_affiliate_conversions\` v
       LEFT JOIN \`tenant_subscriptions\` s ON s.tenant_id = v.tenant_id
       LEFT JOIN \`platform_partner_referrals\` r ON r.id = v.referral_id
      WHERE v.state IN ('referred', 'trial', 'converted', 'paid')${partnerId != null ? " AND v.partner_id = ?" : ""}
      ORDER BY v.id ASC LIMIT 2000`,
    partnerId != null ? [partnerId] : [],
  )
  const nowSql = toSqlDateTime(now)
  let updated = 0
  for (const r of rows) {
    const cur: ConversionRow = {
      state: r.state as ConversionState,
      trialAt: r.trial_at == null ? null : String(r.trial_at),
      convertedAt: r.converted_at == null ? null : String(r.converted_at),
      paidAt: r.paid_at == null ? null : String(r.paid_at),
      firstPaidInvoiceId: r.first_paid_invoice_id == null ? null : Number(r.first_paid_invoice_id),
      cancelledAt: r.cancelled_at == null ? null : String(r.cancelled_at),
    }
    const next = advanceConversion(
      cur,
      {
        subscriptionStatus: r.sub_status ?? null,
        mrr: Number(r.mrr ?? 0),
        firstPaidInvoice: r.paid_invoice_id == null ? null : { id: Number(r.paid_invoice_id), paidAt: String(r.paid_invoice_at) },
        referralActive: r.referral_status == null || r.referral_status === "active",
      },
      nowSql,
    )
    if (!next) continue
    const res: any = await query(
      `UPDATE \`platform_affiliate_conversions\`
          SET \`state\` = ?, \`trial_at\` = ?, \`converted_at\` = ?, \`paid_at\` = ?, \`first_paid_invoice_id\` = ?, \`cancelled_at\` = ?
        WHERE \`id\` = ? AND \`state\` = ?`,
      [next.state, next.trialAt, next.convertedAt, next.paidAt, next.firstPaidInvoiceId, next.cancelledAt, Number(r.id), cur.state],
    )
    if (Number(res?.affectedRows ?? 0) > 0) updated++
  }
  return { scanned: rows.length, updated }
}

// ---------------------------------------------------------------------------
// Commissions & payouts
// ---------------------------------------------------------------------------

async function ledgerFor(partnerId: number) {
  const rows = await query<any[]>(
    `SELECT c.id, c.kind, c.amount, c.currency, po.status AS payout_status
       FROM \`platform_partner_commissions\` c
       LEFT JOIN \`platform_affiliate_payout_items\` pi ON pi.active_commission_id = c.id
       LEFT JOIN \`platform_affiliate_payouts\` po ON po.id = pi.payout_id
      WHERE c.partner_id = ?`,
    [partnerId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind === "clawback" ? ("clawback" as const) : ("commission" as const),
    amountCents: toCents(r.amount),
    currency: r.currency ?? "USD",
    payoutStatus: r.payout_status === "paid" ? ("paid" as const) : r.payout_status === "pending" ? ("pending" as const) : null,
  }))
}

async function pendingFor(partnerId: number, shareBps: number) {
  const rows = await query<any[]>(
    `SELECT i.amount, i.refunded_amount, i.currency
       FROM \`platform_invoices\` i
       JOIN \`platform_partner_referrals\` r ON r.tenant_id = i.tenant_id AND r.partner_id = ? AND r.status = 'active'
      WHERE i.status = 'paid'
        AND NOT EXISTS (SELECT 1 FROM \`platform_partner_commissions\` c WHERE c.invoice_id = i.id AND c.kind = 'commission')`,
    [partnerId],
  )
  return rows.map((r) => ({
    currency: r.currency ?? "USD",
    cents: commissionCents(Math.max(0, toCents(r.amount) - toCents(r.refunded_amount ?? 0)), shareBps),
  }))
}

function mapPayout(r: any) {
  return {
    id: Number(r.id),
    partnerId: Number(r.partner_id),
    currency: r.currency,
    amount: fromCents(toCents(r.amount)),
    status: r.status as PayoutStatus,
    reference: r.reference ?? null,
    voidReason: r.void_reason ?? null,
    createdAt: r.created_at == null ? null : String(r.created_at),
    paidAt: r.paid_at == null ? null : String(r.paid_at),
    voidedAt: r.voided_at == null ? null : String(r.voided_at),
  }
}

export type Payout = ReturnType<typeof mapPayout>

/**
 * Lock every available (settled, not yet paid out) ledger entry for a partner
 * and currency into a pending payout. Serialized per partner by a row lock on
 * the partner; each entry can sit in at most one live payout (DB-enforced).
 * Clawbacks net against commissions; a zero or negative balance carries
 * forward and cannot be paid. Idempotent on `idempotencyKey`.
 */
export async function createPayout(input: { partnerId: number; currency: string; actorUserId: number; idempotencyKey: string }) {
  await ensureAffiliateSchema()
  const replay = async () => {
    const rows = await query<any[]>("SELECT * FROM `platform_affiliate_payouts` WHERE `idempotency_key` = ? LIMIT 1", [input.idempotencyKey])
    if (!rows[0]) return null
    if (Number(rows[0].partner_id) !== input.partnerId || rows[0].currency !== input.currency) {
      throw new PartnerError("Idempotency-Key was already used for a different payout", "IDEMPOTENCY_CONFLICT", 409)
    }
    return { payout: mapPayout(rows[0]), replayed: true, entries: 0 }
  }
  const prior = await replay()
  if (prior) return prior
  await getPartner(input.partnerId)

  try {
    return await withTransaction(async (conn: Conn) => {
      await rowsOf(conn, "SELECT `id` FROM `platform_partners` WHERE `id` = ? FOR UPDATE", [input.partnerId])
      const entries = await rowsOf(
        conn,
        `SELECT c.id, c.amount FROM \`platform_partner_commissions\` c
          WHERE c.partner_id = ? AND c.currency = ?
            AND NOT EXISTS (SELECT 1 FROM \`platform_affiliate_payout_items\` pi WHERE pi.active_commission_id = c.id)
          ORDER BY c.id ASC FOR UPDATE`,
        [input.partnerId, input.currency],
      )
      const totalCents = entries.reduce((s, e) => s + toCents(e.amount), 0)
      if (totalCents <= 0) {
        throw new PartnerError("No positive available balance to pay out", "NOTHING_TO_PAY", 409)
      }
      const createdAt = toSqlDateTime(new Date())
      const [res]: any = await conn.query(
        `INSERT INTO \`platform_affiliate_payouts\` (\`partner_id\`, \`currency\`, \`amount\`, \`status\`, \`idempotency_key\`, \`created_by\`, \`created_at\`)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        [input.partnerId, input.currency, fromCents(totalCents), input.idempotencyKey, input.actorUserId, createdAt],
      )
      const payoutId = Number(res.insertId)
      await conn.query(
        `INSERT INTO \`platform_affiliate_payout_items\` (\`payout_id\`, \`commission_id\`, \`amount\`) VALUES ${entries.map(() => "(?, ?, ?)").join(", ")}`,
        entries.flatMap((e) => [payoutId, Number(e.id), fromCents(toCents(e.amount))]),
      )
      return {
        payout: mapPayout({ id: payoutId, partner_id: input.partnerId, currency: input.currency, amount: fromCents(totalCents), status: "pending", created_at: createdAt }),
        replayed: false,
        entries: entries.length,
      }
    })
  } catch (err) {
    if (isDup(err)) {
      const concurrent = await replay()
      if (concurrent) return concurrent
    }
    throw err
  }
}

/**
 * Mark a pending payout paid (with an external reference) or void it (with a
 * reason). Voiding releases its entries back to the available balance; the
 * payout row and its items are kept as the audit trail. Repeating the same
 * action is an idempotent replay; any other transition from a final state is 409.
 */
export async function transitionPayout(input: {
  payoutId: number
  action: "mark_paid" | "void"
  reference: string | null
  reason: string | null
  actorUserId: number
}) {
  await ensureAffiliateSchema()
  return withTransaction(async (conn: Conn) => {
    const rows = await rowsOf(conn, "SELECT * FROM `platform_affiliate_payouts` WHERE `id` = ? FOR UPDATE", [input.payoutId])
    if (!rows[0]) throw new PartnerError("Payout not found", "NOT_FOUND", 404)
    const cur = mapPayout(rows[0])
    const target: PayoutStatus = input.action === "mark_paid" ? "paid" : "void"
    if (cur.status === target) return { payout: cur, replayed: true, previousStatus: cur.status }
    assertPayoutTransition(cur.status, input.action)
    const at = toSqlDateTime(new Date())
    if (target === "paid") {
      await conn.query(
        "UPDATE `platform_affiliate_payouts` SET `status` = 'paid', `reference` = ?, `paid_by` = ?, `paid_at` = ? WHERE `id` = ? AND `status` = 'pending'",
        [input.reference, input.actorUserId, at, input.payoutId],
      )
    } else {
      await conn.query(
        "UPDATE `platform_affiliate_payouts` SET `status` = 'void', `void_reason` = ?, `voided_by` = ?, `voided_at` = ? WHERE `id` = ? AND `status` = 'pending'",
        [input.reason, input.actorUserId, at, input.payoutId],
      )
      await conn.query("UPDATE `platform_affiliate_payout_items` SET `released` = 1 WHERE `payout_id` = ?", [input.payoutId])
    }
    return {
      payout: { ...cur, status: target, reference: target === "paid" ? input.reference : cur.reference, voidReason: target === "void" ? input.reason : null },
      replayed: false,
      previousStatus: cur.status,
    }
  })
}

export async function listPayouts(partnerId: number | null): Promise<Payout[]> {
  await ensureAffiliateSchema()
  const rows = await query<any[]>(
    `SELECT * FROM \`platform_affiliate_payouts\`${partnerId != null ? " WHERE `partner_id` = ?" : ""} ORDER BY \`id\` DESC LIMIT 200`,
    partnerId != null ? [partnerId] : [],
  )
  return rows.map(mapPayout)
}

/** Commission balances per currency for one partner (admin + portal). */
export async function partnerBalances(partnerId: number, shareBps: number) {
  const [ledger, pending] = await Promise.all([ledgerFor(partnerId), pendingFor(partnerId, shareBps)])
  return commissionTotals(ledger, pending).map((t) => ({
    currency: t.currency,
    pending: fromCents(t.pendingCents),
    available: fromCents(t.availableCents),
    inPayout: fromCents(t.inPayoutCents),
    paidOut: fromCents(t.paidOutCents),
    clawedBack: fromCents(t.clawedBackCents),
  }))
}

// ---------------------------------------------------------------------------
// Affiliate portal (caller = partner member)
// ---------------------------------------------------------------------------

export async function resolveAffiliate(userId: number): Promise<number> {
  const partnerId = await resolvePartnerForUser(userId)
  if (!partnerId) throw new PartnerError("No active affiliate access", "PARTNER_ACCESS_DENIED", 403)
  return partnerId
}

/**
 * Everything the portal shows, restricted to the caller's own partner. The
 * projection is allow-listed: customer name + lifecycle dates only (no tenant
 * ids, no click IP/UA hashes, no rejected signups' identities).
 */
export async function getAffiliatePortal(userId: number, now: Date) {
  const partnerId = await resolveAffiliate(userId)
  await syncConversions(partnerId, now)
  const partner = await getPartner(partnerId)
  const [links, conversions, rejected, clicks, balances, payouts] = await Promise.all([
    listLinks(partnerId),
    query<any[]>(
      `SELECT v.id, v.state, v.referred_at, v.trial_at, v.converted_at, v.paid_at, v.cancelled_at, l.code AS link_code, t.name AS tenant_name
         FROM \`platform_affiliate_conversions\` v
         LEFT JOIN \`platform_affiliate_links\` l ON l.id = v.link_id
         JOIN \`tenants\` t ON t.id = v.tenant_id
        WHERE v.partner_id = ? AND v.state <> 'rejected'
        ORDER BY v.id DESC LIMIT 500`,
      [partnerId],
    ),
    query<any[]>("SELECT COUNT(*) AS c FROM `platform_affiliate_conversions` WHERE `partner_id` = ? AND `state` = 'rejected'", [partnerId]),
    query<any[]>("SELECT COUNT(*) AS c FROM `platform_affiliate_clicks` WHERE `partner_id` = ?", [partnerId]),
    partnerBalances(partnerId, partner.terms.revenueShareBps),
    listPayouts(partnerId),
  ])
  const funnel = { clicks: Number(clicks[0]?.c ?? 0), referred: 0, trial: 0, converted: 0, paid: 0, cancelled: 0, rejected: Number(rejected[0]?.c ?? 0) }
  for (const c of conversions) {
    if (c.state in funnel) (funnel as any)[c.state] += 1
  }
  return {
    affiliate: { name: partner.name, shareBps: partner.terms.revenueShareBps, refundWindowDays: partner.terms.refundWindowDays },
    policy: { attributionDays: attributionDays(), touch: touchPolicy() },
    links,
    funnel,
    conversions: conversions.map((c) => ({
      id: Number(c.id),
      customerName: c.tenant_name,
      state: c.state as ConversionState,
      linkCode: c.link_code ?? null,
      referredAt: c.referred_at == null ? null : String(c.referred_at),
      trialAt: c.trial_at == null ? null : String(c.trial_at),
      convertedAt: c.converted_at == null ? null : String(c.converted_at),
      paidAt: c.paid_at == null ? null : String(c.paid_at),
      cancelledAt: c.cancelled_at == null ? null : String(c.cancelled_at),
    })),
    balances,
    payouts: payouts.map(({ partnerId: _p, voidReason: _v, ...p }) => p),
  }
}
