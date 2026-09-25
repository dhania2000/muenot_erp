import "server-only"

/**
 * Spec29 (#172) — Partner & reseller persistence.
 * ---------------------------------------------------------------------------
 * Partners are PLATFORM-owned records (like platform_invoices), so these tables
 * are intentionally not in the tenant-owned registry. Isolation is enforced
 * here instead: platform routes are guarded by platform roles, and the
 * partner dashboard is pinned to the partner derived from the caller's active
 * membership — never from request input.
 *
 * Commissions settle against the EXISTING platform invoice subsystem
 * (lib/platform-console.ts); refunds recorded there trigger clawbacks here.
 */

import { query, withTransaction } from "@/lib/db"
import { ensureInvoiceRefundSchema } from "@/lib/platform-console"
import {
  PartnerError,
  assertStatusTransition,
  clawbackCents,
  dayOf,
  decideSettlement,
  fromCents,
  summarize,
  toCents,
  toDashboardCommission,
  toDashboardReferral,
  validateTerms,
  type ContractTerms,
  type InvoiceRecord,
  type Ownership,
  type PartnerInput,
  type PartnerRecord,
  type PartnerStatus,
  type ReferralRecord,
} from "@/lib/partners/model"

let ensured: Promise<void> | null = null

export function ensurePartnerSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

async function runEnsure(): Promise<void> {
  await ensureInvoiceRefundSchema()
  await query(`CREATE TABLE IF NOT EXISTS \`platform_partners\` (
    \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`name\` VARCHAR(160) NOT NULL,
    \`kind\` VARCHAR(16) NOT NULL DEFAULT 'referral',
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'active',
    \`contact_email\` VARCHAR(190) DEFAULT NULL,
    \`revenue_share_bps\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`refund_window_days\` INT UNSIGNED NOT NULL DEFAULT 30,
    \`contract_start\` DATE NOT NULL,
    \`contract_end\` DATE DEFAULT NULL,
    \`eligibility_months\` INT UNSIGNED DEFAULT NULL,
    \`idempotency_key\` VARCHAR(100) DEFAULT NULL,
    \`created_by\` INT UNSIGNED DEFAULT NULL,
    \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_partner_idem\` (\`idempotency_key\`),
    KEY \`idx_partner_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`platform_partner_members\` (
    \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`partner_id\` INT UNSIGNED NOT NULL,
    \`user_id\` INT UNSIGNED NOT NULL,
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'active',
    \`created_by\` INT UNSIGNED DEFAULT NULL,
    \`revoked_by\` INT UNSIGNED DEFAULT NULL,
    \`revoked_at\` DATETIME DEFAULT NULL,
    \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_partner_member\` (\`partner_id\`, \`user_id\`),
    KEY \`idx_partner_member_user\` (\`user_id\`, \`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`platform_partner_referrals\` (
    \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`partner_id\` INT UNSIGNED NOT NULL,
    \`tenant_id\` INT UNSIGNED NOT NULL,
    \`ownership\` VARCHAR(16) NOT NULL DEFAULT 'platform',
    \`status\` VARCHAR(16) NOT NULL DEFAULT 'active',
    \`active_tenant_id\` INT UNSIGNED AS (IF(\`status\` = 'active', \`tenant_id\`, NULL)) STORED,
    \`attributed_at\` DATETIME NOT NULL,
    \`ended_at\` DATETIME DEFAULT NULL,
    \`ended_reason\` VARCHAR(300) DEFAULT NULL,
    \`created_by\` INT UNSIGNED DEFAULT NULL,
    \`ended_by\` INT UNSIGNED DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_referral_active_tenant\` (\`active_tenant_id\`),
    KEY \`idx_referral_partner\` (\`partner_id\`, \`status\`),
    KEY \`idx_referral_tenant\` (\`tenant_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS \`platform_partner_commissions\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`entry_key\` VARCHAR(120) NOT NULL,
    \`partner_id\` INT UNSIGNED NOT NULL,
    \`referral_id\` INT UNSIGNED NOT NULL,
    \`tenant_id\` INT UNSIGNED NOT NULL,
    \`invoice_id\` INT UNSIGNED NOT NULL,
    \`kind\` VARCHAR(16) NOT NULL,
    \`amount\` DECIMAL(12,2) NOT NULL,
    \`currency\` VARCHAR(10) NOT NULL DEFAULT 'USD',
    \`share_bps\` INT UNSIGNED NOT NULL,
    \`settled_at\` DATETIME NOT NULL,
    \`created_by\` INT UNSIGNED DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uniq_commission_entry\` (\`entry_key\`),
    KEY \`idx_commission_partner\` (\`partner_id\`, \`settled_at\`),
    KEY \`idx_commission_invoice\` (\`invoice_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ")

function mapPartner(r: any): PartnerRecord & {
  name: string
  kind: string
  contactEmail: string | null
  createdAt: string | null
} {
  return {
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    status: r.status,
    contactEmail: r.contact_email ?? null,
    createdAt: dayOf(r.created_at),
    terms: {
      revenueShareBps: Number(r.revenue_share_bps),
      refundWindowDays: Number(r.refund_window_days),
      contractStart: dayOf(r.contract_start)!,
      contractEnd: dayOf(r.contract_end),
      eligibilityMonths: r.eligibility_months == null ? null : Number(r.eligibility_months),
    },
  }
}

function mapReferral(r: any): ReferralRecord & { ownership: Ownership } {
  return {
    id: Number(r.id),
    partnerId: Number(r.partner_id),
    tenantId: Number(r.tenant_id),
    status: r.status,
    ownership: r.ownership === "partner" ? "partner" : "platform",
    attributedAt: String(r.attributed_at),
    endedAt: r.ended_at == null ? null : String(r.ended_at),
  }
}

// ---------------------------------------------------------------------------
// Partners
// ---------------------------------------------------------------------------

export async function listPartners() {
  await ensurePartnerSchema()
  const rows = await query<any[]>("SELECT * FROM `platform_partners` ORDER BY `name` ASC LIMIT 500")
  return rows.map(mapPartner)
}

export async function getPartner(id: number) {
  await ensurePartnerSchema()
  const rows = await query<any[]>("SELECT * FROM `platform_partners` WHERE `id` = ? LIMIT 1", [id])
  if (!rows[0]) throw new PartnerError("Partner not found", "NOT_FOUND", 404)
  return mapPartner(rows[0])
}

export async function getPartnerDetail(id: number) {
  const partner = await getPartner(id)
  const [referrals, members] = await Promise.all([
    query<any[]>(
      `SELECT r.*, t.name AS tenant_name FROM \`platform_partner_referrals\` r
         LEFT JOIN \`tenants\` t ON t.id = r.tenant_id
        WHERE r.partner_id = ? ORDER BY r.attributed_at DESC`,
      [id],
    ),
    query<any[]>(
      "SELECT `user_id`, `status`, `created_at`, `revoked_at` FROM `platform_partner_members` WHERE `partner_id` = ?",
      [id],
    ),
  ])
  return {
    partner,
    referrals: referrals.map((r) => ({ ...mapReferral(r), tenantName: r.tenant_name ?? null })),
    members: members.map((m) => ({ userId: Number(m.user_id), status: m.status, revokedAt: dayOf(m.revoked_at) })),
  }
}

export async function createPartner(input: PartnerInput, actorUserId: number, idempotencyKey: string | null) {
  await ensurePartnerSchema()
  if (idempotencyKey) {
    const hit = await query<any[]>("SELECT * FROM `platform_partners` WHERE `idempotency_key` = ? LIMIT 1", [idempotencyKey])
    if (hit[0]) return { partner: mapPartner(hit[0]), replayed: true }
  }
  const t = input.terms
  const res: any = await query(
    `INSERT INTO \`platform_partners\`
       (\`name\`, \`kind\`, \`contact_email\`, \`revenue_share_bps\`, \`refund_window_days\`,
        \`contract_start\`, \`contract_end\`, \`eligibility_months\`, \`idempotency_key\`, \`created_by\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.kind,
      input.contactEmail,
      t.revenueShareBps,
      t.refundWindowDays,
      t.contractStart,
      t.contractEnd,
      t.eligibilityMonths,
      idempotencyKey,
      actorUserId,
    ],
  )
  return { partner: await getPartner(Number(res.insertId)), replayed: false }
}

/**
 * Update status and/or contract terms. Terms changes apply to FUTURE
 * settlements only; settled rows keep their share_bps snapshot. Termination
 * closes the contract (contract_end = today if later/open) and revokes every
 * member's dashboard access.
 */
export async function updatePartner(
  id: number,
  patch: { status?: PartnerStatus; terms?: Partial<ContractTerms> },
  actorUserId: number,
) {
  const current = await getPartner(id)
  const nextStatus = patch.status ?? current.status
  assertStatusTransition(current.status, nextStatus)
  if (current.status === "terminated" && patch.terms) {
    throw new PartnerError("A terminated partner's terms are frozen", "PARTNER_TERMINATED", 409)
  }
  const terms = patch.terms ? validateTerms(patch.terms, current.terms) : { ...current.terms }
  const today = dayOf(new Date())!
  if (nextStatus === "terminated" && (terms.contractEnd === null || terms.contractEnd > today)) {
    terms.contractEnd = today < terms.contractStart ? terms.contractStart : today
  }
  await query(
    `UPDATE \`platform_partners\`
        SET \`status\` = ?, \`revenue_share_bps\` = ?, \`refund_window_days\` = ?,
            \`contract_start\` = ?, \`contract_end\` = ?, \`eligibility_months\` = ?
      WHERE \`id\` = ?`,
    [nextStatus, terms.revenueShareBps, terms.refundWindowDays, terms.contractStart, terms.contractEnd, terms.eligibilityMonths, id],
  )
  if (nextStatus === "terminated" && current.status !== "terminated") {
    await query(
      "UPDATE `platform_partner_members` SET `status` = 'revoked', `revoked_by` = ?, `revoked_at` = ? WHERE `partner_id` = ? AND `status` = 'active'",
      [actorUserId, nowSql(), id],
    )
  }
  return { before: current, after: await getPartner(id) }
}

// ---------------------------------------------------------------------------
// Members (dashboard access)
// ---------------------------------------------------------------------------

export async function addMember(partnerId: number, userId: number, actorUserId: number) {
  const partner = await getPartner(partnerId)
  if (partner.status === "terminated") throw new PartnerError("Partner is terminated", "PARTNER_TERMINATED", 409)
  const user = await query<any[]>("SELECT `id` FROM `users` WHERE `id` = ? LIMIT 1", [userId])
  if (!user[0]) throw new PartnerError("User not found", "NOT_FOUND", 404)
  const other = await query<any[]>(
    "SELECT `partner_id` FROM `platform_partner_members` WHERE `user_id` = ? AND `status` = 'active' AND `partner_id` <> ? LIMIT 1",
    [userId, partnerId],
  )
  if (other[0]) throw new PartnerError("User already belongs to another partner", "MEMBER_CONFLICT", 409)
  await query(
    `INSERT INTO \`platform_partner_members\` (\`partner_id\`, \`user_id\`, \`status\`, \`created_by\`)
     VALUES (?, ?, 'active', ?)
     ON DUPLICATE KEY UPDATE \`status\` = 'active', \`revoked_by\` = NULL, \`revoked_at\` = NULL`,
    [partnerId, userId, actorUserId],
  )
}

export async function revokeMember(partnerId: number, userId: number, actorUserId: number) {
  await getPartner(partnerId)
  const res: any = await query(
    "UPDATE `platform_partner_members` SET `status` = 'revoked', `revoked_by` = ?, `revoked_at` = ? WHERE `partner_id` = ? AND `user_id` = ? AND `status` = 'active'",
    [actorUserId, nowSql(), partnerId, userId],
  )
  return { revoked: Number(res?.affectedRows ?? 0) > 0 }
}

// ---------------------------------------------------------------------------
// Referrals (attribution)
// ---------------------------------------------------------------------------

type Conn = { query: (sql: string, params?: any[]) => Promise<any> }
const rowsOf = async (conn: Conn, sql: string, params: any[] = []) => ((await conn.query(sql, params)) as any)[0]

/**
 * Attribute a customer tenant to a partner. One ACTIVE attribution per tenant
 * (DB-enforced). Re-attributing to the same partner is an idempotent no-op;
 * moving to a different partner requires `transfer: true` and closes the old
 * referral as `transferred` in the same transaction.
 */
export async function attributeTenant(input: {
  partnerId: number
  tenantId: number
  ownership: Ownership
  transfer: boolean
  actorUserId: number
}) {
  const partner = await getPartner(input.partnerId)
  if (partner.status !== "active") throw new PartnerError("Partner is not active", "PARTNER_INACTIVE", 409)
  const tenant = await query<any[]>("SELECT `id` FROM `tenants` WHERE `id` = ? LIMIT 1", [input.tenantId])
  if (!tenant[0]) throw new PartnerError("Tenant not found", "NOT_FOUND", 404)

  return withTransaction(async (conn: Conn) => {
    const active = await rowsOf(
      conn,
      "SELECT * FROM `platform_partner_referrals` WHERE `tenant_id` = ? AND `status` = 'active' FOR UPDATE",
      [input.tenantId],
    )
    const cur = active?.[0] ? mapReferral(active[0]) : null
    if (cur && cur.partnerId === input.partnerId) {
      return { referral: cur, replayed: true, previous: null as ReferralRecord | null }
    }
    if (cur && !input.transfer) {
      throw new PartnerError("Tenant is already attributed to another partner", "ALREADY_ATTRIBUTED", 409)
    }
    const at = nowSql()
    if (cur) {
      await conn.query(
        "UPDATE `platform_partner_referrals` SET `status` = 'transferred', `ended_at` = ?, `ended_reason` = ?, `ended_by` = ? WHERE `id` = ? AND `status` = 'active'",
        [at, `transferred to partner ${input.partnerId}`, input.actorUserId, cur.id],
      )
    }
    const [res]: any = await conn.query(
      `INSERT INTO \`platform_partner_referrals\` (\`partner_id\`, \`tenant_id\`, \`ownership\`, \`status\`, \`attributed_at\`, \`created_by\`)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      [input.partnerId, input.tenantId, input.ownership, at, input.actorUserId],
    )
    return {
      referral: {
        id: Number(res.insertId),
        partnerId: input.partnerId,
        tenantId: input.tenantId,
        status: "active" as const,
        ownership: input.ownership,
        attributedAt: at,
        endedAt: null,
      },
      replayed: false,
      previous: cur,
    }
  })
}

/** Cancel an active attribution. Already-settled commissions are untouched. */
export async function cancelReferral(referralId: number, reason: string, actorUserId: number) {
  await ensurePartnerSchema()
  const rows = await query<any[]>("SELECT * FROM `platform_partner_referrals` WHERE `id` = ? LIMIT 1", [referralId])
  if (!rows[0]) throw new PartnerError("Referral not found", "NOT_FOUND", 404)
  const ref = mapReferral(rows[0])
  if (ref.status !== "active") return { referral: ref, replayed: true }
  await query(
    "UPDATE `platform_partner_referrals` SET `status` = 'cancelled', `ended_at` = ?, `ended_reason` = ?, `ended_by` = ? WHERE `id` = ? AND `status` = 'active'",
    [nowSql(), reason, actorUserId, referralId],
  )
  return { referral: { ...ref, status: "cancelled" as const }, replayed: false }
}

// ---------------------------------------------------------------------------
// Settlement & clawback
// ---------------------------------------------------------------------------

async function loadAttributionContext(tenantIds: number[]) {
  if (!tenantIds.length) return { referralsByTenant: new Map<number, ReferralRecord[]>(), partners: new Map<number, PartnerRecord>() }
  const ph = tenantIds.map(() => "?").join(",")
  const refs = (await query<any[]>(`SELECT * FROM \`platform_partner_referrals\` WHERE \`tenant_id\` IN (${ph})`, tenantIds)).map(
    mapReferral,
  )
  const referralsByTenant = new Map<number, ReferralRecord[]>()
  for (const r of refs) referralsByTenant.set(r.tenantId, [...(referralsByTenant.get(r.tenantId) ?? []), r])
  const partnerIds = [...new Set(refs.map((r) => r.partnerId))]
  const partners = new Map<number, PartnerRecord>()
  if (partnerIds.length) {
    const pr = await query<any[]>(
      `SELECT * FROM \`platform_partners\` WHERE \`id\` IN (${partnerIds.map(() => "?").join(",")})`,
      partnerIds,
    )
    for (const p of pr) partners.set(Number(p.id), mapPartner(p))
  }
  return { referralsByTenant, partners }
}

function mapInvoice(r: any): InvoiceRecord & { currency: string; invoiceNumber: string } {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    amount: r.amount,
    refundedAmount: r.refunded_amount ?? 0,
    status: r.status,
    issuedAt: r.issued_at == null ? null : String(r.issued_at),
    periodStart: r.period_start == null ? null : String(r.period_start),
    paidAt: r.paid_at == null ? null : String(r.paid_at),
    currency: r.currency ?? "USD",
    invoiceNumber: r.invoice_number,
  }
}

/**
 * Settle commissions for every verified-paid, attributed invoice whose refund
 * window has elapsed. Idempotent: each invoice has exactly one commission
 * entry (`commission:<invoiceId>`), so concurrent/repeated runs never double pay.
 */
export async function settleCommissions(today: string, actorUserId: number | null) {
  await ensurePartnerSchema()
  const invoices = (
    await query<any[]>(
      `SELECT i.* FROM \`platform_invoices\` i
        WHERE i.status = 'paid' AND i.paid_at IS NOT NULL
          AND i.tenant_id IN (SELECT r.tenant_id FROM \`platform_partner_referrals\` r)
          AND NOT EXISTS (
            SELECT 1 FROM \`platform_partner_commissions\` c WHERE c.invoice_id = i.id AND c.kind = 'commission'
          )
        ORDER BY i.id ASC LIMIT 500`,
    )
  ).map(mapInvoice)

  const { referralsByTenant, partners } = await loadAttributionContext([...new Set(invoices.map((i) => i.tenantId))])
  const settled: { invoiceId: number; partnerId: number; amount: string }[] = []
  const skipped: { invoiceId: number; reason: string }[] = []

  for (const inv of invoices) {
    const d = decideSettlement(inv, referralsByTenant.get(inv.tenantId) ?? [], partners, today)
    if (!d.eligible) {
      skipped.push({ invoiceId: inv.id, reason: d.reason })
      continue
    }
    const res: any = await query(
      `INSERT IGNORE INTO \`platform_partner_commissions\`
         (\`entry_key\`, \`partner_id\`, \`referral_id\`, \`tenant_id\`, \`invoice_id\`, \`kind\`, \`amount\`, \`currency\`, \`share_bps\`, \`settled_at\`, \`created_by\`)
       VALUES (?, ?, ?, ?, ?, 'commission', ?, ?, ?, ?, ?)`,
      [`commission:${inv.id}`, d.partnerId, d.referralId, inv.tenantId, inv.id, fromCents(d.amountCents), inv.currency, d.shareBps, nowSql(), actorUserId],
    )
    if (Number(res?.affectedRows ?? 0) > 0) settled.push({ invoiceId: inv.id, partnerId: d.partnerId, amount: fromCents(d.amountCents) })
    else skipped.push({ invoiceId: inv.id, reason: "already_settled" })
  }
  return { settled, skipped }
}

/**
 * Bring each partner's net commission on an invoice down to what the
 * post-refund (or voided) amount supports. Idempotent per refund state: the
 * entry key embeds the cumulative refunded cents, so replays insert nothing.
 */
export async function applyInvoiceClawback(invoiceId: number, actorUserId: number | null) {
  await ensurePartnerSchema()
  const invRows = await query<any[]>("SELECT * FROM `platform_invoices` WHERE `id` = ? LIMIT 1", [invoiceId])
  if (!invRows[0]) return { clawbacks: [] as { partnerId: number; amount: string }[] }
  const inv = mapInvoice(invRows[0])
  const ledger = await query<any[]>(
    `SELECT \`partner_id\`, \`referral_id\`, \`currency\`,
            MAX(CASE WHEN \`kind\` = 'commission' THEN \`share_bps\` END) AS share_bps,
            SUM(\`amount\`) AS net
       FROM \`platform_partner_commissions\` WHERE \`invoice_id\` = ?
      GROUP BY \`partner_id\`, \`referral_id\`, \`currency\``,
    [invoiceId],
  )
  const refundedCents = inv.status === "void" ? "void" : String(toCents(inv.refundedAmount))
  const clawbacks: { partnerId: number; amount: string }[] = []
  for (const row of ledger) {
    if (row.share_bps == null) continue
    const delta = clawbackCents({
      invoiceAmount: inv.amount,
      refundedAmount: inv.refundedAmount,
      voided: inv.status === "void",
      shareBps: Number(row.share_bps),
      ledgerCents: toCents(row.net),
    })
    if (delta === 0) continue
    const res: any = await query(
      `INSERT IGNORE INTO \`platform_partner_commissions\`
         (\`entry_key\`, \`partner_id\`, \`referral_id\`, \`tenant_id\`, \`invoice_id\`, \`kind\`, \`amount\`, \`currency\`, \`share_bps\`, \`settled_at\`, \`created_by\`)
       VALUES (?, ?, ?, ?, ?, 'clawback', ?, ?, ?, ?, ?)`,
      [
        `clawback:${invoiceId}:${row.partner_id}:${refundedCents}`,
        Number(row.partner_id),
        Number(row.referral_id),
        inv.tenantId,
        invoiceId,
        fromCents(delta),
        row.currency ?? inv.currency,
        Number(row.share_bps),
        nowSql(),
        actorUserId,
      ],
    )
    if (Number(res?.affectedRows ?? 0) > 0) clawbacks.push({ partnerId: Number(row.partner_id), amount: fromCents(delta) })
  }
  return { clawbacks }
}

// ---------------------------------------------------------------------------
// Partner dashboard (caller = partner member)
// ---------------------------------------------------------------------------

/**
 * Resolve the partner for a user from an ACTIVE membership of an ACTIVE
 * partner. Revoked members and suspended/terminated partners get nothing.
 */
export async function resolvePartnerForUser(userId: number): Promise<number | null> {
  await ensurePartnerSchema()
  const rows = await query<any[]>(
    `SELECT m.partner_id FROM \`platform_partner_members\` m
       JOIN \`platform_partners\` p ON p.id = m.partner_id
      WHERE m.user_id = ? AND m.status = 'active' AND p.status = 'active'
      LIMIT 1`,
    [userId],
  )
  return rows[0] ? Number(rows[0].partner_id) : null
}

export async function getPartnerDashboard(userId: number) {
  const partnerId = await resolvePartnerForUser(userId)
  if (!partnerId) throw new PartnerError("No active partner access", "PARTNER_ACCESS_DENIED", 403)
  const partner = await getPartner(partnerId)
  const [refRows, comRows] = await Promise.all([
    query<any[]>(
      `SELECT r.id, r.ownership, r.status, r.attributed_at, r.ended_at, t.name AS tenant_name
         FROM \`platform_partner_referrals\` r
         JOIN \`tenants\` t ON t.id = r.tenant_id
        WHERE r.partner_id = ?
        ORDER BY r.attributed_at DESC LIMIT 500`,
      [partnerId],
    ),
    query<any[]>(
      `SELECT c.id, c.kind, c.amount, c.currency, c.share_bps, c.settled_at, i.invoice_number
         FROM \`platform_partner_commissions\` c
         JOIN \`platform_invoices\` i ON i.id = c.invoice_id
        WHERE c.partner_id = ?
        ORDER BY c.settled_at DESC LIMIT 500`,
      [partnerId],
    ),
  ])
  const commissions = comRows.map(toDashboardCommission)
  return {
    partner: { name: partner.name, kind: partner.kind, terms: partner.terms },
    referrals: refRows.map(toDashboardReferral),
    commissions,
    totals: summarize(commissions),
  }
}
