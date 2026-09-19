import "server-only"
import { query } from "@/lib/db"
import { ensureWhatsAppPlatformTables } from "@/lib/whatsapp-platform"
import { currentTenantId, currentTenantIdOrNull } from "@/lib/tenant-scope"

/**
 * WhatsApp delivery diagnostics.
 *
 * A lightweight, structured log of outbound send outcomes and webhook failures
 * so administrators can see *why* a message did not deliver without digging
 * through server logs. Rows are best-effort: logging must never throw into the
 * send path. A companion classifier decides whether a Meta error is worth
 * retrying (transient/rate-limit) or permanent (bad recipient, policy, auth).
 */

export type DiagnosticDirection = "outbound" | "webhook"
export type DiagnosticOutcome = "success" | "error"

let ensured = false

export async function ensureDiagnosticsTable(): Promise<void> {
  if (ensured) return
  await ensureWhatsAppPlatformTables()
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_whatsapp_diagnostics\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`direction\` VARCHAR(16) NOT NULL,
      \`outcome\` VARCHAR(16) NOT NULL,
      \`context\` VARCHAR(64) NOT NULL,
      \`phone_number\` VARCHAR(32) DEFAULT NULL,
      \`wamid\` VARCHAR(191) DEFAULT NULL,
      \`template_name\` VARCHAR(191) DEFAULT NULL,
      \`campaign_id\` INT UNSIGNED DEFAULT NULL,
      \`error_code\` INT DEFAULT NULL,
      \`retryable\` TINYINT(1) DEFAULT NULL,
      \`message\` VARCHAR(1000) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_marketing_whatsapp_diagnostics_tenant\` (\`tenant_id\`),
      KEY \`idx_wa_diag_outcome\` (\`outcome\`),
      KEY \`idx_wa_diag_context\` (\`context\`),
      KEY \`idx_wa_diag_campaign\` (\`campaign_id\`),
      KEY \`idx_wa_diag_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  // Self-heal for databases created before isolation (mirrors the SQL migration).
  await ensureColumn("marketing_whatsapp_diagnostics", "tenant_id", "ADD COLUMN `tenant_id` INT UNSIGNED DEFAULT NULL AFTER `id`")
  await ensureIndex("marketing_whatsapp_diagnostics", "idx_marketing_whatsapp_diagnostics_tenant", "(`tenant_id`)")
  ensured = true
}

async function ensureColumn(table: string, column: string, alterFragment: string) {
  try {
    const rows = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    )
    if ((rows[0]?.c ?? 0) > 0) return
    await query(`ALTER TABLE \`${table}\` ${alterFragment}`)
  } catch {
    // Concurrent add / missing ALTER rights — safe to ignore.
  }
}

async function ensureIndex(table: string, index: string, cols: string) {
  try {
    const rows = await query<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
        WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, index],
    )
    if ((rows[0]?.c ?? 0) > 0) return
    await query(`ALTER TABLE \`${table}\` ADD KEY \`${index}\` ${cols}`)
  } catch {
    // Concurrent add / missing ALTER rights — safe to ignore.
  }
}

/**
 * Meta Cloud API error codes that are worth retrying because they are
 * transient or rate-limit related. Everything else (invalid recipient,
 * 24h-window, template/policy, auth) is treated as permanent so we do not
 * hammer Meta with sends that can never succeed.
 *
 * Refs: WhatsApp Cloud API error code reference.
 */
const RETRYABLE_ERROR_CODES = new Set<number>([
  1, // Unknown/transient API error
  2, // Service temporarily unavailable
  4, // API rate limit hit
  80007, // Rate limit hit
  130429, // Cloud API message throughput reached
  131000, // Something went wrong (generic transient)
  131016, // Service unavailable
  131026, // Message undeliverable (often transient capacity)
  131056, // (Business, recipient) pair rate limit hit
  133016, // Temporarily blocked for restrictions
])

/** Classifies a Meta error code (and HTTP-ish fallbacks) as retryable. */
export function isRetryableErrorCode(code: number | null | undefined): boolean {
  if (code == null) return true // unknown cause -> allow one retry
  if (RETRYABLE_ERROR_CODES.has(code)) return true
  // Treat raw 5xx HTTP statuses that leak through as transient.
  if (code >= 500 && code < 600) return true
  return false
}

export async function logDiagnostic(entry: {
  direction: DiagnosticDirection
  outcome: DiagnosticOutcome
  context: string
  phoneNumber?: string | null
  wamid?: string | null
  templateName?: string | null
  campaignId?: number | null
  errorCode?: number | null
  message?: string | null
}): Promise<void> {
  try {
    await ensureDiagnosticsTable()
    const retryable =
      entry.outcome === "error" ? (isRetryableErrorCode(entry.errorCode) ? 1 : 0) : null
    await query(
      `INSERT INTO \`marketing_whatsapp_diagnostics\`
        (tenant_id, direction, outcome, context, phone_number, wamid, template_name, campaign_id, error_code, retryable, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        currentTenantIdOrNull(),
        entry.direction,
        entry.outcome,
        entry.context.slice(0, 64),
        entry.phoneNumber ?? null,
        entry.wamid ?? null,
        entry.templateName ?? null,
        entry.campaignId ?? null,
        entry.errorCode ?? null,
        retryable,
        entry.message ? entry.message.slice(0, 1000) : null,
      ],
    )
  } catch (err) {
    // Diagnostics must never break the send path.
    console.error("[v0] whatsapp diagnostic log failed:", (err as Error).message)
  }
}

export type DiagnosticRow = {
  id: number
  direction: string
  outcome: string
  context: string
  phone_number: string | null
  wamid: string | null
  template_name: string | null
  campaign_id: number | null
  error_code: number | null
  retryable: number | null
  message: string | null
  created_at: string
}

/** Recent diagnostics for the admin surface, newest first. */
export async function listDiagnostics(options: {
  limit?: number
  outcome?: DiagnosticOutcome
  campaignId?: number
} = {}): Promise<DiagnosticRow[]> {
  await ensureDiagnosticsTable()
  const where: string[] = ["tenant_id = ?"]
  const params: (string | number)[] = [currentTenantId()]
  if (options.outcome) {
    where.push("outcome = ?")
    params.push(options.outcome)
  }
  if (options.campaignId) {
    where.push("campaign_id = ?")
    params.push(options.campaignId)
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  const sql = `SELECT * FROM \`marketing_whatsapp_diagnostics\`
    WHERE ${where.join(" AND ")}
    ORDER BY id DESC LIMIT ${limit}`
  return query<DiagnosticRow[]>(sql, params)
}

/** Aggregate error counts grouped by code for a quick failure summary. */
export async function summarizeErrors(sinceHours = 24): Promise<
  { error_code: number | null; retryable: number | null; count: number; sample: string | null }[]
> {
  await ensureDiagnosticsTable()
  return query(
    `SELECT error_code, retryable, COUNT(*) AS count, MAX(message) AS sample
       FROM \`marketing_whatsapp_diagnostics\`
      WHERE tenant_id = ? AND outcome = 'error' AND created_at >= (NOW() - INTERVAL ? HOUR)
      GROUP BY error_code, retryable
      ORDER BY count DESC`,
    [currentTenantId(), sinceHours],
  )
}
