import "server-only"
import crypto from "crypto"
import { query } from "@/lib/db"
import { pool } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { sendEmail, renderTemplate, isEmailConfigured, resolveBaseUrl } from "@/lib/email"
import {
  ensureContactSchema,
  isEligible,
  eligibilityReason,
  recordContactActivity,
  normalizeEmail,
} from "@/lib/marketing/contacts-db"

/**
 * Email Campaign service — the ONE place that owns campaign state.
 *
 * It deliberately does NOT introduce a new contact master, template store, or
 * mail transport. Instead it composes the ERP's existing building blocks:
 *   - audience  -> marketing_contacts / marketing_segments / marketing_contact_tags
 *   - eligibility (consent / suppression) -> isEligible() from contacts-db
 *   - templates -> sales_email_templates (the same store journeys read from)
 *   - transport -> sendEmail() in lib/email.ts (shared mailbox or the sender's
 *                  own connected Gmail via senderUserId)
 *   - auto IDs  -> nextRecordId() (race-safe record_id_sequences)
 *   - contact timeline -> recordContactActivity()
 *
 * Everything campaign-specific (the campaign, its materialized recipients, the
 * open/click/unsubscribe events, and the audit trail) lives in its own tables.
 */

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const CAMPAIGN_TYPES = ["Newsletter", "Promotional", "Announcement", "Transactional", "Re-engagement"] as const
export type CampaignType = (typeof CAMPAIGN_TYPES)[number]

// Draft -> Scheduled -> Sending -> Sent, with Paused / Cancelled / Failed off to the side.
export const CAMPAIGN_STATUSES = ["Draft", "Scheduled", "Sending", "Paused", "Sent", "Cancelled", "Failed"] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

// Per-recipient delivery lifecycle. "Sent" = accepted by the transport; we do
// not fake "Delivered" without provider confirmation.
export const RECIPIENT_STATUSES = [
  "Queued",
  "Sending",
  "Sent",
  "Delivered",
  "Opened",
  "Clicked",
  "Bounced",
  "Failed",
  "Unsubscribed",
  "Skipped",
] as const
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number]

/** How many recipients a single send pass will process (rate limit / batch). */
export const SEND_BATCH_SIZE = 25
export const MAX_SEND_ATTEMPTS = 4
/** Campaigns use the general business mailbox, same as marketing journeys. */
const CAMPAIGN_DEPARTMENT = "sales" as const

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CampaignConflictError extends Error {
  constructor(message = "This campaign was modified by someone else. Refresh and try again.") {
    super(message)
    this.name = "CampaignConflictError"
  }
}
export class CampaignNotFoundError extends Error {
  constructor(message = "Campaign not found") {
    super(message)
    this.name = "CampaignNotFoundError"
  }
}
export class CampaignStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CampaignStateError"
  }
}

// ---------------------------------------------------------------------------
// Schema self-heal (mirrors the pattern used across the ERP)
// ---------------------------------------------------------------------------

let ensured = false

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}
async function addColumnIfMissing(table: string, column: string, ddl: string) {
  if (await columnExists(table, column)) return
  await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`).catch(() => {})
}

export async function ensureCampaignSchema() {
  if (ensured) return
  await ensureContactSchema()

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_email_campaigns (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      campaign_code VARCHAR(40) NOT NULL,
      name VARCHAR(180) NOT NULL,
      description VARCHAR(500) NULL,
      type VARCHAR(30) NOT NULL DEFAULT 'Newsletter',
      status ENUM('Draft','Scheduled','Sending','Paused','Sent','Cancelled','Failed') NOT NULL DEFAULT 'Draft',
      from_name VARCHAR(160) NULL,
      reply_to VARCHAR(190) NULL,
      preheader VARCHAR(255) NULL,
      subject VARCHAR(255) NOT NULL DEFAULT '',
      body_html LONGTEXT NULL,
      template_id BIGINT UNSIGNED NULL,
      -- audience definition (resolved into recipients at schedule/send time)
      audience_mode ENUM('all','segments','tags','contacts') NOT NULL DEFAULT 'segments',
      audience_segments JSON NULL,
      audience_tags JSON NULL,
      audience_contacts JSON NULL,
      exclude_unsubscribed TINYINT(1) NOT NULL DEFAULT 1,
      -- scheduling
      scheduled_at DATETIME NULL,
      timezone VARCHAR(60) NULL,
      -- tracking toggles
      track_opens TINYINT(1) NOT NULL DEFAULT 1,
      track_clicks TINYINT(1) NOT NULL DEFAULT 1,
      -- lifecycle bookkeeping
      audience_size INT UNSIGNED NOT NULL DEFAULT 0,
      excluded_size INT UNSIGNED NOT NULL DEFAULT 0,
      sent_count INT UNSIGNED NOT NULL DEFAULT 0,
      failed_count INT UNSIGNED NOT NULL DEFAULT 0,
      started_at DATETIME NULL,
      completed_at DATETIME NULL,
      last_error VARCHAR(500) NULL,
      owner_id INT UNSIGNED NULL,
      sender_user_id INT UNSIGNED NULL,
      row_version INT UNSIGNED NOT NULL DEFAULT 1,
      created_by INT UNSIGNED NULL,
      archived_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_campaign_code (campaign_code),
      KEY idx_mec_status (status),
      KEY idx_mec_queue (status, scheduled_at),
      KEY idx_mec_owner (owner_id),
      KEY idx_mec_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Additive guards so an older table is upgraded in place.
  const cols: [string, string][] = [
    ["preheader", "`preheader` VARCHAR(255) NULL"],
    ["reply_to", "`reply_to` VARCHAR(190) NULL"],
    ["from_name", "`from_name` VARCHAR(160) NULL"],
    ["exclude_unsubscribed", "`exclude_unsubscribed` TINYINT(1) NOT NULL DEFAULT 1"],
    ["track_opens", "`track_opens` TINYINT(1) NOT NULL DEFAULT 1"],
    ["track_clicks", "`track_clicks` TINYINT(1) NOT NULL DEFAULT 1"],
    ["sender_user_id", "`sender_user_id` INT UNSIGNED NULL"],
    ["excluded_size", "`excluded_size` INT UNSIGNED NOT NULL DEFAULT 0"],
    ["started_at", "`started_at` DATETIME NULL"],
    ["completed_at", "`completed_at` DATETIME NULL"],
    ["archived_at", "`archived_at` DATETIME NULL"],
  ]
  for (const [c, ddl] of cols) await addColumnIfMissing("marketing_email_campaigns", c, ddl)

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_campaign_recipients (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      campaign_id BIGINT UNSIGNED NOT NULL,
      contact_id BIGINT UNSIGNED NULL,
      contact_code VARCHAR(40) NULL,
      email VARCHAR(190) NOT NULL,
      email_normalized VARCHAR(190) NOT NULL,
      name VARCHAR(190) NULL,
      vars JSON NULL,
      status ENUM('Queued','Sending','Sent','Delivered','Opened','Clicked','Bounced','Failed','Unsubscribed','Skipped')
        NOT NULL DEFAULT 'Queued',
      skip_reason VARCHAR(120) NULL,
      tracking_token VARCHAR(64) NOT NULL,
      unsubscribe_token VARCHAR(64) NOT NULL,
      message_id VARCHAR(255) NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      last_error VARCHAR(500) NULL,
      sent_at DATETIME NULL,
      first_opened_at DATETIME NULL,
      last_opened_at DATETIME NULL,
      open_count INT UNSIGNED NOT NULL DEFAULT 0,
      first_clicked_at DATETIME NULL,
      last_clicked_at DATETIME NULL,
      click_count INT UNSIGNED NOT NULL DEFAULT 0,
      bounced_at DATETIME NULL,
      unsubscribed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_campaign_email (campaign_id, email_normalized),
      UNIQUE KEY uq_tracking_token (tracking_token),
      UNIQUE KEY uq_unsub_token (unsubscribe_token),
      KEY idx_mcr_campaign_status (campaign_id, status),
      KEY idx_mcr_contact (contact_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_campaign_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      campaign_id BIGINT UNSIGNED NOT NULL,
      recipient_id BIGINT UNSIGNED NOT NULL,
      event_type ENUM('sent','open','click','bounce','unsubscribe','fail') NOT NULL,
      url VARCHAR(1000) NULL,
      user_agent VARCHAR(400) NULL,
      ip_address VARCHAR(64) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_mce_campaign (campaign_id, event_type),
      KEY idx_mce_recipient (recipient_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS marketing_campaign_audit (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      campaign_id BIGINT UNSIGNED NOT NULL,
      action VARCHAR(60) NOT NULL,
      summary VARCHAR(255) NOT NULL,
      meta JSON NULL,
      actor_id INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_mca_campaign (campaign_id),
      KEY idx_mca_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Register permission features so the matrix can gate this screen.
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Email Campaigns','marketing.campaigns.view','View email campaigns and analytics',60 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})
  await query(
    `INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
     SELECT id,'Manage Email Campaigns','marketing.campaigns.manage','Create, edit, schedule and send email campaigns',61 FROM modules WHERE slug='marketing'`,
  ).catch(() => {})

  ensured = true
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function recordCampaignAudit(input: {
  campaignId: number
  action: string
  summary: string
  meta?: Record<string, any> | null
  actorId?: number | null
}): Promise<void> {
  await query(
    `INSERT INTO marketing_campaign_audit (campaign_id, action, summary, meta, actor_id) VALUES (?,?,?,?,?)`,
    [input.campaignId, input.action, input.summary.slice(0, 255), input.meta ? JSON.stringify(input.meta) : null, input.actorId ?? null],
  ).catch((e) => console.error("[campaigns-db] audit failed", e))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMysqlDateTime(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace("T", " ")
}

function parseJsonArray(value: any): any[] {
  if (Array.isArray(value)) return value
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

/** Build the {{field}} merge vars for a contact row (mirrors journeys). */
export function contactVars(contact: Record<string, any>): Record<string, string> {
  const first = String(contact.first_name ?? "").trim() || String(contact.full_name ?? "").trim().split(/\s+/)[0] || ""
  return {
    first_name: first,
    last_name: String(contact.last_name ?? ""),
    full_name: String(contact.full_name ?? ""),
    name: String(contact.full_name ?? "") || first,
    email: String(contact.email ?? ""),
    company: String(contact.company_name ?? ""),
    company_name: String(contact.company_name ?? ""),
    job_title: String(contact.job_title ?? ""),
    city: String(contact.city ?? ""),
    country: String(contact.country ?? ""),
  }
}

// ---------------------------------------------------------------------------
// Content composition (subject/body snapshot -> personalized, tracked HTML)
// ---------------------------------------------------------------------------

/** Wrap outbound links so clicks are recorded, then redirected to the target. */
function rewriteLinks(html: string, baseUrl: string, token: string): string {
  return html.replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, (_m, q, url) => {
    const wrapped = `${baseUrl}/api/marketing/campaigns/click/${token}?u=${encodeURIComponent(url)}`
    return `href=${q}${wrapped}${q}`
  })
}

function trackingPixel(baseUrl: string, token: string): string {
  return `<img src="${baseUrl}/api/marketing/campaigns/track/${token}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;" />`
}

function unsubscribeFooter(baseUrl: string, token: string): string {
  const url = `${baseUrl}/api/marketing/campaigns/unsubscribe/${token}`
  return `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280;font-family:Arial,Helvetica,sans-serif;">
    You are receiving this email because you opted in to updates from Muenot Technologies.
    <a href="${url}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>.
  </div>`
}

export type ComposedEmail = { subject: string; html: string }

/**
 * Personalize + assemble the final HTML for one recipient: merge {{vars}},
 * prepend the preheader, rewrite links for click tracking, append the
 * unsubscribe footer and (optionally) the open pixel.
 */
export function composeForRecipient(
  campaign: Record<string, any>,
  recipient: { tracking_token: string; unsubscribe_token: string; vars: Record<string, string> },
  baseUrl: string,
): ComposedEmail {
  const vars = recipient.vars || {}
  const subject = renderTemplate(String(campaign.subject || ""), vars)
  let body = renderTemplate(String(campaign.body_html || ""), vars)

  const preheader = campaign.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${renderTemplate(String(campaign.preheader), vars)}</div>`
    : ""

  if (campaign.track_clicks) body = rewriteLinks(body, baseUrl, recipient.tracking_token)
  body = `${preheader}${body}${unsubscribeFooter(baseUrl, recipient.unsubscribe_token)}`
  if (campaign.track_opens) body = `${body}${trackingPixel(baseUrl, recipient.tracking_token)}`

  return { subject, html: body }
}

// ---------------------------------------------------------------------------
// Audience resolution
// ---------------------------------------------------------------------------

export type AudienceDefinition = {
  mode: "all" | "segments" | "tags" | "contacts"
  segmentIds?: number[]
  tags?: string[]
  contactIds?: number[]
  excludeUnsubscribed?: boolean
}

export type ResolvedContact = Record<string, any>

/** Load the distinct, non-archived contacts matched by an audience definition. */
export async function resolveAudienceContacts(def: AudienceDefinition): Promise<ResolvedContact[]> {
  await ensureContactSchema()
  const base = `SELECT DISTINCT c.* FROM marketing_contacts c`
  let sql = ""
  let args: any[] = []

  if (def.mode === "all") {
    sql = `${base} WHERE c.archived_at IS NULL`
  } else if (def.mode === "segments") {
    const ids = (def.segmentIds || []).filter((n) => Number.isFinite(n))
    if (ids.length === 0) return []
    sql = `${base}
      JOIN marketing_segment_members m ON m.contact_id = c.id
      WHERE c.archived_at IS NULL AND m.segment_id IN (${ids.map(() => "?").join(",")})`
    args = ids
  } else if (def.mode === "tags") {
    const tags = (def.tags || []).map((t) => String(t).trim()).filter(Boolean)
    if (tags.length === 0) return []
    sql = `${base}
      JOIN marketing_contact_tags t ON t.contact_id = c.id
      WHERE c.archived_at IS NULL AND t.tag IN (${tags.map(() => "?").join(",")})`
    args = tags
  } else {
    const ids = (def.contactIds || []).filter((n) => Number.isFinite(n))
    if (ids.length === 0) return []
    sql = `${base} WHERE c.archived_at IS NULL AND c.id IN (${ids.map(() => "?").join(",")})`
    args = ids
  }

  return query<any[]>(sql, args).catch(() => [] as any[])
}

export type AudiencePreview = {
  total: number
  eligible: number
  excluded: number
  reasons: Record<string, number>
  sample: { name: string; email: string; eligible: boolean; reason: string }[]
}

/**
 * Resolve an audience and split it into eligible / excluded, deduping by
 * normalized email. Powers the builder's live "who will receive this" preview
 * and is the exact same logic used to materialize recipients at send time.
 */
export async function previewAudience(def: AudienceDefinition): Promise<AudiencePreview> {
  const contacts = await resolveAudienceContacts(def)
  const seen = new Set<string>()
  const reasons: Record<string, number> = {}
  const sample: AudiencePreview["sample"] = []
  let eligible = 0
  let excluded = 0
  let total = 0

  for (const c of contacts) {
    const norm = normalizeEmail(c.email)
    if (!norm) {
      excluded++
      total++
      reasons["No email"] = (reasons["No email"] || 0) + 1
      if (sample.length < 8) sample.push({ name: c.full_name, email: c.email || "—", eligible: false, reason: "No email" })
      continue
    }
    if (seen.has(norm)) continue // dedupe silently
    seen.add(norm)
    total++
    const ok = isEligible(c, "email")
    if (ok) {
      eligible++
      if (sample.length < 8) sample.push({ name: c.full_name, email: c.email, eligible: true, reason: "Eligible" })
    } else {
      excluded++
      const reason = eligibilityReason(c, "email")
      reasons[reason] = (reasons[reason] || 0) + 1
      if (sample.length < 8) sample.push({ name: c.full_name, email: c.email, eligible: false, reason })
    }
  }

  return { total, eligible, excluded, reasons, sample }
}

// ---------------------------------------------------------------------------
// Campaign read helpers
// ---------------------------------------------------------------------------

export function audienceOf(campaign: Record<string, any>): AudienceDefinition {
  return {
    mode: campaign.audience_mode,
    segmentIds: parseJsonArray(campaign.audience_segments).map(Number),
    tags: parseJsonArray(campaign.audience_tags).map(String),
    contactIds: parseJsonArray(campaign.audience_contacts).map(Number),
    excludeUnsubscribed: Boolean(campaign.exclude_unsubscribed),
  }
}

export async function getCampaign(id: number): Promise<Record<string, any> | null> {
  const rows = await query<any[]>(`SELECT * FROM marketing_email_campaigns WHERE id = ? LIMIT 1`, [id])
  return rows[0] || null
}

export async function getCampaignAnalytics(campaignId: number) {
  const rows = await query<any[]>(
    `SELECT
        COUNT(*) AS recipients,
        SUM(status = 'Queued') AS queued,
        SUM(status = 'Sending') AS sending,
        SUM(status IN ('Sent','Delivered','Opened','Clicked')) AS sent,
        SUM(status = 'Bounced') AS bounced,
        SUM(status = 'Failed') AS failed,
        SUM(status = 'Unsubscribed') AS unsubscribed,
        SUM(status = 'Skipped') AS skipped,
        SUM(open_count > 0) AS opened_unique,
        SUM(open_count) AS opens_total,
        SUM(click_count > 0) AS clicked_unique,
        SUM(click_count) AS clicks_total
     FROM marketing_campaign_recipients WHERE campaign_id = ?`,
    [campaignId],
  )
  const r = rows[0] || {}
  const num = (v: any) => Number(v || 0)
  const sent = num(r.sent)
  const openedUnique = num(r.opened_unique)
  const clickedUnique = num(r.clicked_unique)
  const bounced = num(r.bounced)
  const unsub = num(r.unsubscribed)
  const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)
  return {
    recipients: num(r.recipients),
    queued: num(r.queued),
    sending: num(r.sending),
    sent,
    bounced,
    failed: num(r.failed),
    unsubscribed: unsub,
    skipped: num(r.skipped),
    openedUnique,
    opensTotal: num(r.opens_total),
    clickedUnique,
    clicksTotal: num(r.clicks_total),
    openRate: rate(openedUnique, sent),
    clickRate: rate(clickedUnique, sent),
    clickToOpenRate: rate(clickedUnique, openedUnique),
    bounceRate: rate(bounced, sent + bounced),
    unsubscribeRate: rate(unsub, sent),
  }
}

// ---------------------------------------------------------------------------
// Recipient materialization (audience snapshot at schedule/send time)
// ---------------------------------------------------------------------------

/**
 * Freeze the current audience into marketing_campaign_recipients. Eligible
 * contacts become Queued rows; excluded ones are stored as Skipped rows (with a
 * reason) so the reason is auditable. Idempotent per (campaign, email).
 */
export async function materializeRecipients(campaign: Record<string, any>): Promise<{ eligible: number; excluded: number }> {
  const def = audienceOf(campaign)
  const contacts = await resolveAudienceContacts(def)
  const seen = new Set<string>()
  let eligible = 0
  let excluded = 0

  for (const c of contacts) {
    const norm = normalizeEmail(c.email)
    if (!norm || seen.has(norm)) {
      if (!norm) excluded++
      continue
    }
    seen.add(norm)
    const ok = isEligible(c, "email")
    const status: RecipientStatus = ok ? "Queued" : "Skipped"
    const reason = ok ? null : eligibilityReason(c, "email")
    if (ok) eligible++
    else excluded++

    const vars = contactVars(c)
    await query(
      `INSERT INTO marketing_campaign_recipients
        (campaign_id, contact_id, contact_code, email, email_normalized, name, vars, status, skip_reason,
         tracking_token, unsubscribe_token)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), vars = VALUES(vars),
         status = IF(marketing_campaign_recipients.status IN ('Queued','Skipped'), VALUES(status), marketing_campaign_recipients.status),
         skip_reason = VALUES(skip_reason)`,
      [
        campaign.id,
        c.id,
        c.contact_code || null,
        c.email,
        norm,
        c.full_name || null,
        JSON.stringify(vars),
        status,
        reason,
        crypto.randomBytes(24).toString("hex"),
        crypto.randomBytes(24).toString("hex"),
      ],
    ).catch((e) => console.error("[campaigns-db] materialize insert failed", e))
  }

  await query(
    `UPDATE marketing_email_campaigns SET audience_size = ?, excluded_size = ? WHERE id = ?`,
    [eligible, excluded, campaign.id],
  )
  return { eligible, excluded }
}

// ---------------------------------------------------------------------------
// Send engine (batched, idempotent, retry-aware)
// ---------------------------------------------------------------------------

/** Atomically claim one Queued recipient by flipping it to Sending. */
async function claimRecipient(recipientId: number): Promise<boolean> {
  const res = await query<any>(
    `UPDATE marketing_campaign_recipients SET status = 'Sending' WHERE id = ? AND status = 'Queued'`,
    [recipientId],
  )
  return Number((res as any)?.affectedRows || 0) === 1
}

/**
 * Process up to SEND_BATCH_SIZE queued recipients for a Sending campaign.
 * Returns how many remain queued so the caller (cron / send-now) can loop or
 * mark the campaign complete. Safe to call concurrently — each recipient is
 * claimed atomically before any mail goes out, so no address is sent twice.
 */
export async function processCampaignBatch(
  campaignId: number,
  baseUrl: string,
  limit = SEND_BATCH_SIZE,
): Promise<{ processed: number; sent: number; failed: number; remaining: number; done: boolean }> {
  await ensureCampaignSchema()
  const campaign = await getCampaign(campaignId)
  if (!campaign) throw new CampaignNotFoundError()
  if (campaign.status !== "Sending") {
    return { processed: 0, sent: 0, failed: 0, remaining: 0, done: campaign.status === "Sent" }
  }

  if (!isEmailConfigured(CAMPAIGN_DEPARTMENT) && !campaign.sender_user_id) {
    // No shared transport and no personal mailbox — surface it instead of
    // silently looping forever.
    await query(`UPDATE marketing_email_campaigns SET last_error = ? WHERE id = ?`, [
      "No mailbox connected. Connect an email account to send.",
      campaignId,
    ])
  }

  const queued = await query<any[]>(
    `SELECT * FROM marketing_campaign_recipients
      WHERE campaign_id = ? AND status = 'Queued'
      ORDER BY id ASC LIMIT ?`,
    [campaignId, limit],
  )

  let sent = 0
  let failed = 0
  for (const r of queued) {
    if (!(await claimRecipient(r.id))) continue // someone else took it
    const vars = (() => {
      try {
        return typeof r.vars === "string" ? JSON.parse(r.vars) : r.vars || {}
      } catch {
        return {}
      }
    })()
    const composed = composeForRecipient(campaign, { tracking_token: r.tracking_token, unsubscribe_token: r.unsubscribe_token, vars }, baseUrl)
    try {
      const result = await sendEmail({
        to: r.email,
        subject: composed.subject,
        html: composed.html,
        from: campaign.from_name ? undefined : undefined,
        department: CAMPAIGN_DEPARTMENT,
        senderUserId: campaign.sender_user_id ? Number(campaign.sender_user_id) : null,
        headers: campaign.reply_to ? { "Reply-To": String(campaign.reply_to) } : undefined,
      })
      await query(
        `UPDATE marketing_campaign_recipients
            SET status = 'Sent', message_id = ?, sent_at = NOW(), attempts = attempts + 1, last_error = NULL
          WHERE id = ?`,
        [result.messageId || null, r.id],
      )
      await query(
        `INSERT INTO marketing_campaign_events (campaign_id, recipient_id, event_type) VALUES (?,?,'sent')`,
        [campaignId, r.id],
      )
      if (r.contact_id) {
        await recordContactActivity({
          contactId: Number(r.contact_id),
          contactCode: r.contact_code,
          type: "campaign",
          summary: `Campaign email sent: ${composed.subject}`.slice(0, 255),
          meta: { campaign_id: campaignId, campaign_code: campaign.campaign_code },
        })
        await query(`UPDATE marketing_contacts SET last_campaign_at = NOW() WHERE id = ?`, [r.contact_id]).catch(() => {})
      }
      sent++
    } catch (err: any) {
      const attempts = Number(r.attempts || 0) + 1
      const message = String(err?.message || "Send failed").slice(0, 500)
      const terminal = attempts >= MAX_SEND_ATTEMPTS
      await query(
        `UPDATE marketing_campaign_recipients
            SET status = ?, attempts = ?, last_error = ? WHERE id = ?`,
        [terminal ? "Failed" : "Queued", attempts, message, r.id],
      )
      if (terminal) {
        await query(`INSERT INTO marketing_campaign_events (campaign_id, recipient_id, event_type) VALUES (?,?,'fail')`, [campaignId, r.id])
        failed++
      }
      console.error("[campaigns-db] send failed", campaignId, r.email, message)
    }
  }

  const remainingRows = await query<any[]>(
    `SELECT COUNT(*) AS n FROM marketing_campaign_recipients WHERE campaign_id = ? AND status IN ('Queued','Sending')`,
    [campaignId],
  )
  const remaining = Number(remainingRows[0]?.n || 0)

  // Refresh the campaign counters.
  await query(
    `UPDATE marketing_email_campaigns c
        SET sent_count = (SELECT COUNT(*) FROM marketing_campaign_recipients r WHERE r.campaign_id = c.id AND r.status IN ('Sent','Delivered','Opened','Clicked')),
            failed_count = (SELECT COUNT(*) FROM marketing_campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'Failed')
      WHERE c.id = ?`,
    [campaignId],
  )

  const done = remaining === 0
  if (done) {
    await query(
      `UPDATE marketing_email_campaigns SET status = 'Sent', completed_at = NOW() WHERE id = ? AND status = 'Sending'`,
      [campaignId],
    )
  }

  return { processed: sent + failed, sent, failed, remaining, done }
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

const CONTENT_REQUIRED = "Add a subject and body before sending."

function validateSendable(campaign: Record<string, any>): string | null {
  if (!String(campaign.subject || "").trim()) return CONTENT_REQUIRED
  if (!String(campaign.body_html || "").trim()) return CONTENT_REQUIRED
  return null
}

/** Move a Draft/Scheduled campaign into Sending and freeze its audience. */
export async function startSending(campaign: Record<string, any>, actorId: number | null): Promise<{ eligible: number; excluded: number }> {
  const err = validateSendable(campaign)
  if (err) throw new CampaignStateError(err)
  const { eligible, excluded } = await materializeRecipients(campaign)
  if (eligible === 0) throw new CampaignStateError("No eligible recipients — everyone in this audience is unsubscribed, bounced, or has no email.")
  await query(
    `UPDATE marketing_email_campaigns
        SET status = 'Sending', started_at = COALESCE(started_at, NOW()), last_error = NULL, row_version = row_version + 1
      WHERE id = ?`,
    [campaign.id],
  )
  await recordCampaignAudit({
    campaignId: campaign.id,
    action: "send",
    summary: `Sending started — ${eligible} recipient(s), ${excluded} excluded`,
    meta: { eligible, excluded },
    actorId,
  })
  return { eligible, excluded }
}

export async function scheduleCampaign(campaign: Record<string, any>, scheduledAtIso: string, timezone: string | null, actorId: number | null) {
  const err = validateSendable(campaign)
  if (err) throw new CampaignStateError(err)
  const dt = toMysqlDateTime(scheduledAtIso)
  if (!dt) throw new CampaignStateError("A valid date and time is required to schedule.")
  if (new Date(scheduledAtIso).getTime() <= Date.now()) throw new CampaignStateError("Choose a time in the future.")
  await query(
    `UPDATE marketing_email_campaigns SET status = 'Scheduled', scheduled_at = ?, timezone = ?, last_error = NULL, row_version = row_version + 1 WHERE id = ?`,
    [dt, timezone, campaign.id],
  )
  await recordCampaignAudit({ campaignId: campaign.id, action: "schedule", summary: `Scheduled for ${dt} ${timezone || "UTC"}`, actorId })
}

export async function pauseCampaign(campaign: Record<string, any>, actorId: number | null) {
  if (campaign.status !== "Sending") throw new CampaignStateError("Only a sending campaign can be paused.")
  await query(`UPDATE marketing_email_campaigns SET status = 'Paused', row_version = row_version + 1 WHERE id = ?`, [campaign.id])
  await recordCampaignAudit({ campaignId: campaign.id, action: "pause", summary: "Sending paused", actorId })
}

export async function resumeCampaign(campaign: Record<string, any>, actorId: number | null) {
  if (campaign.status !== "Paused") throw new CampaignStateError("Only a paused campaign can be resumed.")
  await query(`UPDATE marketing_email_campaigns SET status = 'Sending', row_version = row_version + 1 WHERE id = ?`, [campaign.id])
  await recordCampaignAudit({ campaignId: campaign.id, action: "resume", summary: "Sending resumed", actorId })
}

export async function cancelCampaign(campaign: Record<string, any>, actorId: number | null) {
  if (!["Scheduled", "Sending", "Paused"].includes(campaign.status)) {
    throw new CampaignStateError("Only a scheduled, sending or paused campaign can be cancelled.")
  }
  await query(`UPDATE marketing_email_campaigns SET status = 'Cancelled', row_version = row_version + 1 WHERE id = ?`, [campaign.id])
  // Stop any remaining queued recipients from going out.
  await query(
    `UPDATE marketing_campaign_recipients SET status = 'Skipped', skip_reason = 'Campaign cancelled' WHERE campaign_id = ? AND status IN ('Queued','Sending')`,
    [campaign.id],
  )
  await recordCampaignAudit({ campaignId: campaign.id, action: "cancel", summary: "Campaign cancelled", actorId })
}

/** Send a one-off test to an arbitrary address using sample/self vars. */
export async function sendTestEmail(campaign: Record<string, any>, toEmail: string, baseUrl: string, senderUserId: number | null): Promise<void> {
  const err = validateSendable(campaign)
  if (err) throw new CampaignStateError(err)
  const vars = contactVars({ full_name: "Test Recipient", first_name: "Test", email: toEmail, company_name: "Muenot Technologies" })
  const fakeRecipient = {
    tracking_token: "test-" + crypto.randomBytes(8).toString("hex"),
    unsubscribe_token: "test-" + crypto.randomBytes(8).toString("hex"),
    vars,
  }
  // For tests we skip open/click tracking rewrites so we don't pollute analytics.
  const composed = composeForRecipient(
    { ...campaign, track_opens: 0, track_clicks: 0 },
    fakeRecipient,
    baseUrl,
  )
  await sendEmail({
    to: toEmail,
    subject: `[TEST] ${composed.subject}`,
    html: composed.html,
    department: CAMPAIGN_DEPARTMENT,
    senderUserId: senderUserId ?? (campaign.sender_user_id ? Number(campaign.sender_user_id) : null),
    headers: campaign.reply_to ? { "Reply-To": String(campaign.reply_to) } : undefined,
  })
}
