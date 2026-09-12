import "server-only"
import { query } from "@/lib/db"
import { ensureWhatsAppPlatformTables } from "@/lib/whatsapp-platform"
import { getWhatsAppIntegration, sendWhatsAppTemplateWithComponents } from "@/lib/whatsapp"
import {
  findOrCreateContact,
  findOrCreateConversation,
  recordOutboundMessage,
  normalizePhone,
} from "@/lib/whatsapp-store"
import { getAudience, resolveAudience, type AudienceContact } from "@/lib/whatsapp-audiences"
import type { AudienceFilter } from "@/lib/whatsapp-config"

/**
 * Campaign (broadcast) engine.
 *
 * A campaign sends one approved template to a resolved audience. Sending is
 * batched (`processCampaignBatch`) so the scheduler can drain a large audience
 * across several ticks without hitting Meta's rate limits or a request timeout.
 * Per-recipient delivery state lives in marketing_whatsapp_campaign_recipients
 * and is reconciled from webhook status callbacks by wamid.
 */

let ensured = false

export async function ensureCampaignTables() {
  if (ensured) return
  await ensureWhatsAppPlatformTables()
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_campaigns\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(191) NOT NULL,
      \`type\` VARCHAR(48) NOT NULL DEFAULT 'promotional',
      \`department_id\` INT UNSIGNED DEFAULT NULL,
      \`audience_id\` INT UNSIGNED DEFAULT NULL,
      \`audience_filter_json\` TEXT DEFAULT NULL,
      \`template_name\` VARCHAR(191) DEFAULT NULL,
      \`template_language\` VARCHAR(16) DEFAULT NULL,
      \`variables_json\` TEXT DEFAULT NULL,
      \`media_link\` VARCHAR(1000) DEFAULT NULL,
      \`header_media_id\` VARCHAR(191) DEFAULT NULL,
      \`scheduled_at\` DATETIME DEFAULT NULL,
      \`timezone\` VARCHAR(64) DEFAULT 'Asia/Kolkata',
      \`status\` ENUM('draft','scheduled','running','paused','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
      \`total_recipients\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`sent_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`delivered_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`read_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`failed_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`replied_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`launched_by\` INT UNSIGNED DEFAULT NULL,
      \`launched_at\` DATETIME DEFAULT NULL,
      \`completed_at\` DATETIME DEFAULT NULL,
      \`last_error\` VARCHAR(500) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_wa_campaign_status\` (\`status\`),
      KEY \`idx_wa_campaign_scheduled\` (\`scheduled_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_campaign_recipients\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`campaign_id\` INT UNSIGNED NOT NULL,
      \`contact_id\` INT UNSIGNED DEFAULT NULL,
      \`phone_number\` VARCHAR(32) NOT NULL,
      \`variables_json\` TEXT DEFAULT NULL,
      \`wamid\` VARCHAR(191) DEFAULT NULL,
      \`status\` ENUM('pending','sent','delivered','read','failed','replied') NOT NULL DEFAULT 'pending',
      \`error_message\` VARCHAR(500) DEFAULT NULL,
      \`sent_at\` DATETIME DEFAULT NULL,
      \`delivered_at\` DATETIME DEFAULT NULL,
      \`read_at\` DATETIME DEFAULT NULL,
      \`replied_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_wa_camp_recipient\` (\`campaign_id\`, \`phone_number\`),
      KEY \`idx_wa_camp_recipient_campaign\` (\`campaign_id\`),
      KEY \`idx_wa_camp_recipient_wamid\` (\`wamid\`),
      KEY \`idx_wa_camp_recipient_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_campaign_events\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`campaign_id\` INT UNSIGNED NOT NULL,
      \`recipient_id\` BIGINT UNSIGNED DEFAULT NULL,
      \`event_type\` VARCHAR(32) NOT NULL,
      \`detail\` VARCHAR(500) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_wa_camp_event_campaign\` (\`campaign_id\`),
      KEY \`idx_wa_camp_event_type\` (\`event_type\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  ensured = true
}

export type CampaignRow = {
  id: number
  name: string
  type: string
  department_id: number | null
  audience_id: number | null
  audience_filter_json: string | null
  template_name: string | null
  template_language: string | null
  variables_json: string | null
  media_link: string | null
  header_media_id: string | null
  scheduled_at: string | null
  timezone: string | null
  status: string
  total_recipients: number
  sent_count: number
  delivered_count: number
  read_count: number
  failed_count: number
  replied_count: number
  created_by: number | null
  launched_at: string | null
  completed_at: string | null
  last_error: string | null
  created_at: string
}

export type Campaign = ReturnType<typeof toCampaign>

function toCampaign(r: CampaignRow & { created_by_name?: string | null; audience_name?: string | null }) {
  let variables: string[] = []
  try {
    if (r.variables_json) variables = JSON.parse(r.variables_json)
  } catch {
    variables = []
  }
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    departmentId: r.department_id,
    audienceId: r.audience_id,
    audienceName: r.audience_name ?? null,
    templateName: r.template_name,
    templateLanguage: r.template_language,
    variables,
    mediaLink: r.media_link,
    headerMediaId: r.header_media_id,
    scheduledAt: r.scheduled_at,
    timezone: r.timezone,
    status: r.status,
    totalRecipients: Number(r.total_recipients),
    sentCount: Number(r.sent_count),
    deliveredCount: Number(r.delivered_count),
    readCount: Number(r.read_count),
    failedCount: Number(r.failed_count),
    repliedCount: Number(r.replied_count),
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? null,
    launchedAt: r.launched_at,
    completedAt: r.completed_at,
    lastError: r.last_error,
    createdAt: r.created_at,
  }
}

export async function listCampaigns(): Promise<Campaign[]> {
  await ensureCampaignTables()
  const rows = await query<(CampaignRow & { created_by_name: string | null; audience_name: string | null })[]>(
    `SELECT c.*, u.name AS created_by_name, a.name AS audience_name
       FROM \`marketing_whatsapp_campaigns\` c
       LEFT JOIN \`users\` u ON u.id = c.created_by
       LEFT JOIN \`marketing_whatsapp_audiences\` a ON a.id = c.audience_id
      ORDER BY c.created_at DESC`,
  )
  return rows.map(toCampaign)
}

export async function getCampaign(id: number): Promise<Campaign | null> {
  await ensureCampaignTables()
  const rows = await query<(CampaignRow & { created_by_name: string | null; audience_name: string | null })[]>(
    `SELECT c.*, u.name AS created_by_name, a.name AS audience_name
       FROM \`marketing_whatsapp_campaigns\` c
       LEFT JOIN \`users\` u ON u.id = c.created_by
       LEFT JOIN \`marketing_whatsapp_audiences\` a ON a.id = c.audience_id
      WHERE c.id = ? LIMIT 1`,
    [id],
  )
  return rows[0] ? toCampaign(rows[0]) : null
}

export async function createCampaign(input: {
  name: string
  type?: string
  departmentId?: number | null
  audienceId?: number | null
  templateName: string
  templateLanguage?: string
  variables?: string[]
  mediaLink?: string | null
  headerMediaId?: string | null
  scheduledAt?: string | null
  createdBy: number | null
}): Promise<number> {
  await ensureCampaignTables()
  const status = input.scheduledAt ? "scheduled" : "draft"
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`marketing_whatsapp_campaigns\`
       (name, type, department_id, audience_id, template_name, template_language, variables_json,
        media_link, header_media_id, scheduled_at, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name.trim(),
      input.type || "promotional",
      input.departmentId ?? null,
      input.audienceId ?? null,
      input.templateName.trim(),
      input.templateLanguage || "en_US",
      JSON.stringify(input.variables ?? []),
      input.mediaLink?.trim() || null,
      input.headerMediaId?.trim() || null,
      input.scheduledAt || null,
      status,
      input.createdBy,
    ],
  )
  return result.insertId
}

export async function updateCampaign(
  id: number,
  patch: Partial<{
    name: string
    type: string
    departmentId: number | null
    audienceId: number | null
    templateName: string
    templateLanguage: string
    variables: string[]
    mediaLink: string | null
    headerMediaId: string | null
    scheduledAt: string | null
    status: string
  }>,
): Promise<void> {
  await ensureCampaignTables()
  const map: Record<string, string> = {
    name: "name",
    type: "type",
    departmentId: "department_id",
    audienceId: "audience_id",
    templateName: "template_name",
    templateLanguage: "template_language",
    mediaLink: "media_link",
    headerMediaId: "header_media_id",
    scheduledAt: "scheduled_at",
    status: "status",
  }
  const sets: string[] = []
  const params: (string | number | null)[] = []
  for (const [k, col] of Object.entries(map)) {
    if ((patch as Record<string, unknown>)[k] !== undefined) {
      sets.push(`\`${col}\` = ?`)
      const v = (patch as Record<string, unknown>)[k]
      params.push(v === null ? null : typeof v === "number" ? v : String(v))
    }
  }
  if (patch.variables !== undefined) {
    sets.push("`variables_json` = ?")
    params.push(JSON.stringify(patch.variables))
  }
  if (!sets.length) return
  params.push(id)
  await query(`UPDATE \`marketing_whatsapp_campaigns\` SET ${sets.join(", ")} WHERE id = ?`, params)
}

export async function deleteCampaign(id: number): Promise<void> {
  await ensureCampaignTables()
  await query("DELETE FROM `marketing_whatsapp_campaigns` WHERE id = ?", [id])
}

async function logEvent(campaignId: number, type: string, detail?: string | null, recipientId?: number | null) {
  await query(
    "INSERT INTO `marketing_whatsapp_campaign_events` (campaign_id, recipient_id, event_type, detail) VALUES (?, ?, ?, ?)",
    [campaignId, recipientId ?? null, type, detail ?? null],
  )
}

/** Resolves the campaign's audience into recipient rows (pending). */
export async function buildCampaignRecipients(campaignId: number): Promise<number> {
  await ensureCampaignTables()
  const campaign = await getCampaign(campaignId)
  if (!campaign) throw new Error("Campaign not found")

  let recipients: AudienceContact[] = []
  if (campaign.audienceId) {
    const audience = await getAudience(campaign.audienceId)
    if (audience) recipients = await resolveAudience(audience.filter)
  } else if (campaign.status !== "draft") {
    // No audience → whole opted-in book.
    recipients = await resolveAudience({ match: "AND", conditions: [] } as AudienceFilter)
  } else {
    recipients = await resolveAudience({ match: "AND", conditions: [] } as AudienceFilter)
  }

  let inserted = 0
  for (const r of recipients) {
    const phone = normalizePhone(r.phone)
    if (!phone) continue
    const vars = campaign.variables.map((v) => substituteVariable(v, r))
    const res = await query<{ affectedRows: number }>(
      `INSERT IGNORE INTO \`marketing_whatsapp_campaign_recipients\`
         (campaign_id, contact_id, phone_number, variables_json, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [campaignId, r.contactId, phone, JSON.stringify(vars)],
    )
    if (res.affectedRows) inserted++
  }

  await query("UPDATE `marketing_whatsapp_campaigns` SET total_recipients = ? WHERE id = ?", [inserted, campaignId])
  return inserted
}

/** Replaces {{name}} / {{phone}} tokens in a variable value for one recipient. */
function substituteVariable(template: string, contact: AudienceContact): string {
  return template
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name || "there")
    .replace(/\{\{\s*phone\s*\}\}/gi, contact.phone)
}

/** Puts a campaign into the send queue. Builds recipients then sends a first batch. */
export async function launchCampaign(id: number, userId: number, batchSize = 50): Promise<{ status: string; total: number }> {
  await ensureCampaignTables()
  const campaign = await getCampaign(id)
  if (!campaign) throw new Error("Campaign not found")
  if (!campaign.templateName) throw new Error("Campaign has no template")
  if (campaign.status === "running") return { status: "running", total: campaign.totalRecipients }

  const total = await buildCampaignRecipients(id)
  await query(
    "UPDATE `marketing_whatsapp_campaigns` SET status = 'running', launched_by = ?, launched_at = NOW(), last_error = NULL WHERE id = ?",
    [userId, id],
  )
  await logEvent(id, "launched", `${total} recipients`)

  await processCampaignBatch(id, batchSize)
  const after = await getCampaign(id)
  return { status: after?.status ?? "running", total }
}

/**
 * Sends up to `limit` pending recipients for a running campaign. Returns the
 * number processed; when zero pending remain the campaign is completed. Safe to
 * call repeatedly (from the scheduler) to drain a large audience.
 */
export async function processCampaignBatch(id: number, limit = 50): Promise<{ processed: number; remaining: number }> {
  await ensureCampaignTables()
  const campaign = await getCampaign(id)
  if (!campaign || campaign.status !== "running") return { processed: 0, remaining: 0 }

  const integration = await getWhatsAppIntegration()
  if (!integration) {
    await query("UPDATE `marketing_whatsapp_campaigns` SET status = 'failed', last_error = ? WHERE id = ?", [
      "No WhatsApp account connected",
      id,
    ])
    return { processed: 0, remaining: 0 }
  }

  const pending = await query<{ id: number; contact_id: number | null; phone_number: string; variables_json: string | null }[]>(
    "SELECT id, contact_id, phone_number, variables_json FROM `marketing_whatsapp_campaign_recipients` WHERE campaign_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?",
    [id, limit],
  )

  let processed = 0
  for (const r of pending) {
    let vars: string[] = []
    try {
      vars = r.variables_json ? JSON.parse(r.variables_json) : []
    } catch {
      vars = []
    }

    const result = await sendWhatsAppTemplateWithComponents({
      integration,
      to: r.phone_number,
      templateName: campaign.templateName!,
      languageCode: campaign.templateLanguage || "en_US",
      bodyParams: vars,
      headerMedia:
        campaign.mediaLink || campaign.headerMediaId
          ? { kind: "image", link: campaign.mediaLink || undefined, id: campaign.headerMediaId || undefined }
          : null,
    })

    if (result.ok) {
      await query(
        "UPDATE `marketing_whatsapp_campaign_recipients` SET status = 'sent', wamid = ?, sent_at = NOW(), error_message = NULL WHERE id = ?",
        [result.messageId ?? null, r.id],
      )
      await query("UPDATE `marketing_whatsapp_campaigns` SET sent_count = sent_count + 1 WHERE id = ?", [id])
      // Mirror the broadcast into the inbox so replies thread correctly.
      try {
        const contact = r.contact_id
          ? { id: r.contact_id }
          : await findOrCreateContact({ phone: r.phone_number })
        const conversation = await findOrCreateConversation({
          contactId: contact.id,
          phoneNumberId: integration.phone_number_id,
          wabaId: integration.waba_id,
        })
        const messageId = await recordOutboundMessage({
          conversationId: conversation.id,
          wamid: result.messageId ?? null,
          messageType: "template",
          body: `[campaign] ${campaign.templateName}`,
          senderPhone: integration.display_phone_number?.replace(/[^\d]/g, "") ?? null,
          recipientPhone: r.phone_number,
          status: "sent",
          sentByUserId: campaign.createdBy,
        })
        await query("UPDATE `marketing_whatsapp_messages` SET campaign_id = ? WHERE id = ?", [id, messageId])
      } catch (err) {
        console.error("[v0] campaign inbox mirror failed:", (err as Error).message)
      }
    } else {
      await query(
        "UPDATE `marketing_whatsapp_campaign_recipients` SET status = 'failed', error_message = ? WHERE id = ?",
        [(result.error || "send failed").slice(0, 500), r.id],
      )
      await query("UPDATE `marketing_whatsapp_campaigns` SET failed_count = failed_count + 1 WHERE id = ?", [id])
      await logEvent(id, "failed", result.error ?? null, r.id)
    }
    processed++
  }

  const remainingRows = await query<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM `marketing_whatsapp_campaign_recipients` WHERE campaign_id = ? AND status = 'pending'",
    [id],
  )
  const remaining = Number(remainingRows[0]?.c ?? 0)
  if (remaining === 0) {
    await query("UPDATE `marketing_whatsapp_campaigns` SET status = 'completed', completed_at = NOW() WHERE id = ?", [id])
    await logEvent(id, "completed")
  }

  return { processed, remaining }
}

export async function pauseCampaign(id: number): Promise<void> {
  await ensureCampaignTables()
  await query("UPDATE `marketing_whatsapp_campaigns` SET status = 'paused' WHERE id = ? AND status = 'running'", [id])
  await logEvent(id, "paused")
}

export async function resumeCampaign(id: number, batchSize = 50): Promise<void> {
  await ensureCampaignTables()
  await query("UPDATE `marketing_whatsapp_campaigns` SET status = 'running' WHERE id = ? AND status = 'paused'", [id])
  await logEvent(id, "resumed")
  await processCampaignBatch(id, batchSize)
}

export async function cancelCampaign(id: number): Promise<void> {
  await ensureCampaignTables()
  await query(
    "UPDATE `marketing_whatsapp_campaigns` SET status = 'cancelled' WHERE id = ? AND status IN ('draft','scheduled','running','paused')",
    [id],
  )
  await query(
    "UPDATE `marketing_whatsapp_campaign_recipients` SET status = 'failed', error_message = 'Campaign cancelled' WHERE campaign_id = ? AND status = 'pending'",
    [id],
  )
  await logEvent(id, "cancelled")
}

/* ------------------------------------------------------------------ */
/* Webhook reconciliation (called from the webhook route)              */
/* ------------------------------------------------------------------ */

/** Advances a campaign recipient's delivery state from a status callback. */
export async function applyCampaignStatusByWamid(wamid: string, status: "delivered" | "read" | "failed"): Promise<void> {
  await ensureCampaignTables()
  const rows = await query<{ id: number; campaign_id: number; status: string }[]>(
    "SELECT id, campaign_id, status FROM `marketing_whatsapp_campaign_recipients` WHERE wamid = ? LIMIT 1",
    [wamid],
  )
  const recipient = rows[0]
  if (!recipient) return

  if (status === "delivered" && recipient.status === "sent") {
    await query("UPDATE `marketing_whatsapp_campaign_recipients` SET status = 'delivered', delivered_at = NOW() WHERE id = ?", [recipient.id])
    await query("UPDATE `marketing_whatsapp_campaigns` SET delivered_count = delivered_count + 1 WHERE id = ?", [recipient.campaign_id])
  } else if (status === "read" && (recipient.status === "sent" || recipient.status === "delivered")) {
    await query("UPDATE `marketing_whatsapp_campaign_recipients` SET status = 'read', read_at = NOW() WHERE id = ?", [recipient.id])
    await query("UPDATE `marketing_whatsapp_campaigns` SET read_count = read_count + 1 WHERE id = ?", [recipient.campaign_id])
  } else if (status === "failed") {
    await query("UPDATE `marketing_whatsapp_campaign_recipients` SET status = 'failed' WHERE id = ?", [recipient.id])
    await query("UPDATE `marketing_whatsapp_campaigns` SET failed_count = failed_count + 1 WHERE id = ?", [recipient.campaign_id])
  }
}

/** Marks the most recent campaign recipient for a phone number as replied. */
export async function markCampaignReplied(phone: string): Promise<void> {
  await ensureCampaignTables()
  const normalized = normalizePhone(phone)
  const rows = await query<{ id: number; campaign_id: number }[]>(
    `SELECT id, campaign_id FROM \`marketing_whatsapp_campaign_recipients\`
      WHERE phone_number = ? AND status IN ('sent','delivered','read')
      ORDER BY sent_at DESC LIMIT 1`,
    [normalized],
  )
  const recipient = rows[0]
  if (!recipient) return
  await query("UPDATE `marketing_whatsapp_campaign_recipients` SET status = 'replied', replied_at = NOW() WHERE id = ?", [recipient.id])
  await query("UPDATE `marketing_whatsapp_campaigns` SET replied_count = replied_count + 1 WHERE id = ?", [recipient.campaign_id])
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

/**
 * One scheduler tick: launches scheduled campaigns whose time has come and
 * drains a batch for each running campaign. Meant to be pinged by a cron job.
 */
export async function runCampaignScheduler(batchSize = 50): Promise<{ launched: number; drained: number }> {
  await ensureCampaignTables()
  let launched = 0
  let drained = 0

  const due = await query<{ id: number; created_by: number | null }[]>(
    "SELECT id, created_by FROM `marketing_whatsapp_campaigns` WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()",
  )
  for (const c of due) {
    try {
      await launchCampaign(c.id, c.created_by ?? 0, batchSize)
      launched++
    } catch (err) {
      console.error("[v0] scheduler launch failed:", (err as Error).message)
    }
  }

  const running = await query<{ id: number }[]>("SELECT id FROM `marketing_whatsapp_campaigns` WHERE status = 'running'")
  for (const c of running) {
    try {
      const { processed } = await processCampaignBatch(c.id, batchSize)
      if (processed) drained++
    } catch (err) {
      console.error("[v0] scheduler drain failed:", (err as Error).message)
    }
  }

  return { launched, drained }
}

export async function getCampaignRecipients(id: number, limit = 200) {
  await ensureCampaignTables()
  return query<
    { id: number; phone_number: string; status: string; error_message: string | null; sent_at: string | null }[]
  >(
    "SELECT id, phone_number, status, error_message, sent_at FROM `marketing_whatsapp_campaign_recipients` WHERE campaign_id = ? ORDER BY id ASC LIMIT ?",
    [id, limit],
  )
}
