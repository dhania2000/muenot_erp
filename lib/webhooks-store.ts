import "server-only"
/**
 * SPEC 68-70 — Webhook endpoint registry + delivery ledger.
 * ---------------------------------------------------------------------------
 * Endpoints are tenant-owned subscriptions to named business events (see
 * WEBHOOK_EVENTS below). Each endpoint gets a per-endpoint signing secret,
 * stored only as the AES-256-GCM envelope from lib/secrets/crypto.ts (the
 * same boundary used for SSO client secrets and managed secrets), never in
 * plaintext. lib/webhooks/dispatcher.ts owns actually sending deliveries and
 * signing payloads with this secret; this module is the persistence layer.
 */
import { query } from "@/lib/db"
import { decryptSecret, encryptSecret } from "@/lib/secrets/crypto"

export type WebhookEndpointStatus = "active" | "disabled"
export type WebhookDeliveryStatus = "pending" | "success" | "failed"

/** Every business event a tenant can subscribe an endpoint to. */
export const WEBHOOK_EVENTS = [
  { value: "client.created", label: "Client created" },
  { value: "client.updated", label: "Client updated" },
] as const

export type WebhookEndpointRow = {
  id: number
  tenant_id: number
  url: string
  description: string | null
  events: string
  secret_encrypted: string | null
  /** JSON object of extra request headers to send with every delivery. */
  custom_headers: string | null
  status: WebhookEndpointStatus
  created_by: number | null
  created_at: string
  updated_at: string
  last_delivery_at: string | null
  last_delivery_ok: number | null
  failure_count: number
}

export type PublicWebhookEndpoint = Omit<WebhookEndpointRow, "secret_encrypted" | "tenant_id" | "custom_headers"> & {
  hasSecret: boolean
  tenantId: number
  customHeaders: Record<string, string>
}

/**
 * Header names the delivery signs and sets itself — a subscriber can never
 * override these via custom headers, or they could forge the signature chain.
 */
export const RESERVED_WEBHOOK_HEADERS = new Set([
  "content-type",
  "x-webhook-signature",
  "x-webhook-timestamp",
  "x-webhook-event",
])

/**
 * Validate and normalize a caller-supplied header map: string→string only,
 * reserved headers stripped, capped in count and size. Returns null when the
 * input is not a flat string map at all.
 */
export function sanitizeCustomHeaders(input: unknown): Record<string, string> | null {
  if (input === null || input === undefined) return {}
  if (typeof input !== "object" || Array.isArray(input)) return null
  const out: Record<string, string> = {}
  let count = 0
  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    const key = rawKey.trim()
    if (!key) continue
    if (typeof rawVal !== "string") return null
    if (!/^[A-Za-z0-9-]+$/.test(key)) return null
    if (RESERVED_WEBHOOK_HEADERS.has(key.toLowerCase())) continue
    if (++count > 20) break
    out[key] = rawVal.slice(0, 1000)
  }
  return out
}

/** Parse the stored JSON header blob into a plain object, never throwing. */
export function resolveEndpointHeaders(row: WebhookEndpointRow): Record<string, string> {
  if (!row.custom_headers) return {}
  try {
    const parsed = JSON.parse(row.custom_headers)
    return sanitizeCustomHeaders(parsed) ?? {}
  } catch {
    return {}
  }
}

export type WebhookDeliveryRow = {
  id: number
  endpoint_id: number
  tenant_id: number
  event_type: string
  payload: string
  status: WebhookDeliveryStatus
  attempts: number
  response_code: number | null
  response_body: string | null
  next_retry_at: string | null
  created_at: string
  delivered_at: string | null
}

let ensured: Promise<void> | null = null

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

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`webhook_endpoints\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`url\` VARCHAR(500) NOT NULL,
      \`description\` VARCHAR(255) DEFAULT NULL,
      \`events\` VARCHAR(500) NOT NULL DEFAULT '',
      \`secret_encrypted\` TEXT DEFAULT NULL,
      \`custom_headers\` TEXT DEFAULT NULL,
      \`status\` ENUM('active','disabled') NOT NULL DEFAULT 'active',
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`last_delivery_at\` DATETIME DEFAULT NULL,
      \`last_delivery_ok\` TINYINT(1) DEFAULT NULL,
      \`failure_count\` INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (\`id\`),
      KEY \`idx_webhook_endpoints_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`webhook_deliveries\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`endpoint_id\` INT UNSIGNED NOT NULL,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`event_type\` VARCHAR(80) NOT NULL,
      \`payload\` MEDIUMTEXT NOT NULL,
      \`status\` ENUM('pending','success','failed') NOT NULL DEFAULT 'pending',
      \`attempts\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`response_code\` INT DEFAULT NULL,
      \`response_body\` VARCHAR(500) DEFAULT NULL,
      \`next_retry_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`delivered_at\` DATETIME DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_webhook_deliveries_endpoint\` (\`endpoint_id\`),
      KEY \`idx_webhook_deliveries_tenant\` (\`tenant_id\`),
      KEY \`idx_webhook_deliveries_retry\` (\`status\`, \`next_retry_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  // SPEC 54 — backfill the custom-headers column on tables created before it existed.
  await addColumnIfMissing("webhook_endpoints", "custom_headers", "`custom_headers` TEXT DEFAULT NULL")
}

export async function ensureWebhooksSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

export function toPublicEndpoint(row: WebhookEndpointRow): PublicWebhookEndpoint {
  const { secret_encrypted, tenant_id, custom_headers, ...rest } = row
  return {
    ...rest,
    hasSecret: Boolean(secret_encrypted),
    tenantId: tenant_id,
    customHeaders: resolveEndpointHeaders(row),
  }
}

export async function listEndpoints(tenantId: number): Promise<PublicWebhookEndpoint[]> {
  await ensureWebhooksSchema()
  const rows = await query<WebhookEndpointRow[]>(
    `SELECT * FROM \`webhook_endpoints\` WHERE \`tenant_id\` = ? ORDER BY \`created_at\` DESC`,
    [tenantId],
  )
  return rows.map(toPublicEndpoint)
}

/** Every active endpoint subscribed to `eventType`, across the given tenant. */
export async function listActiveEndpointsForEvent(
  tenantId: number,
  eventType: string,
): Promise<WebhookEndpointRow[]> {
  await ensureWebhooksSchema()
  const rows = await query<WebhookEndpointRow[]>(
    `SELECT * FROM \`webhook_endpoints\` WHERE \`tenant_id\` = ? AND \`status\` = 'active'`,
    [tenantId],
  )
  return rows.filter((r) => r.events.split(",").includes(eventType))
}

export async function getEndpointById(tenantId: number, id: number): Promise<WebhookEndpointRow | null> {
  await ensureWebhooksSchema()
  const rows = await query<WebhookEndpointRow[]>(
    `SELECT * FROM \`webhook_endpoints\` WHERE \`id\` = ? AND \`tenant_id\` = ? LIMIT 1`,
    [id, tenantId],
  )
  return rows[0] ?? null
}

export function resolveEndpointSecret(row: WebhookEndpointRow): string | null {
  return decryptSecret(row.secret_encrypted)
}

export type EndpointInput = {
  url: string
  description?: string | null
  events: string[]
  headers?: Record<string, string> | null
}

function serializeHeaders(headers: Record<string, string> | null | undefined): string | null {
  const clean = sanitizeCustomHeaders(headers ?? {})
  if (!clean || Object.keys(clean).length === 0) return null
  return JSON.stringify(clean)
}

export async function createEndpoint(
  tenantId: number,
  input: EndpointInput,
  createdBy: number,
): Promise<{ endpoint: PublicWebhookEndpoint; secret: string }> {
  await ensureWebhooksSchema()
  const crypto = await import("crypto")
  const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`webhook_endpoints\` (\`tenant_id\`, \`url\`, \`description\`, \`events\`, \`secret_encrypted\`, \`custom_headers\`, \`status\`, \`created_by\`)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    [
      tenantId,
      input.url.trim(),
      input.description ?? null,
      input.events.join(","),
      encryptSecret(secret),
      serializeHeaders(input.headers),
      createdBy,
    ],
  )
  const id = (result as any).insertId as number
  const rows = await query<WebhookEndpointRow[]>(`SELECT * FROM \`webhook_endpoints\` WHERE \`id\` = ?`, [id])
  return { endpoint: toPublicEndpoint(rows[0]), secret }
}

export async function updateEndpoint(
  tenantId: number,
  id: number,
  input: Partial<EndpointInput & { status: WebhookEndpointStatus }>,
): Promise<void> {
  await ensureWebhooksSchema()
  const sets: string[] = []
  const params: unknown[] = []
  if (input.url !== undefined) {
    sets.push("`url` = ?")
    params.push(input.url.trim())
  }
  if (input.description !== undefined) {
    sets.push("`description` = ?")
    params.push(input.description)
  }
  if (input.events !== undefined) {
    sets.push("`events` = ?")
    params.push(input.events.join(","))
  }
  if (input.headers !== undefined) {
    sets.push("`custom_headers` = ?")
    params.push(serializeHeaders(input.headers))
  }
  if (input.status !== undefined) {
    sets.push("`status` = ?")
    params.push(input.status)
  }
  if (sets.length === 0) return
  params.push(id, tenantId)
  await query(`UPDATE \`webhook_endpoints\` SET ${sets.join(", ")} WHERE \`id\` = ? AND \`tenant_id\` = ?`, params)
}

export async function deleteEndpoint(tenantId: number, id: number): Promise<void> {
  await ensureWebhooksSchema()
  await query(`DELETE FROM \`webhook_deliveries\` WHERE \`endpoint_id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])
  await query(`DELETE FROM \`webhook_endpoints\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])
}

export async function recordDeliveryOutcome(
  endpointId: number,
  ok: boolean,
): Promise<void> {
  await query(
    `UPDATE \`webhook_endpoints\`
       SET \`last_delivery_at\` = CURRENT_TIMESTAMP,
           \`last_delivery_ok\` = ?,
           \`failure_count\` = ${ok ? "0" : "\`failure_count\` + 1"}
     WHERE \`id\` = ?`,
    [ok ? 1 : 0, endpointId],
  )
}

export async function createDelivery(input: {
  endpointId: number
  tenantId: number
  eventType: string
  payload: string
}): Promise<number> {
  await ensureWebhooksSchema()
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`webhook_deliveries\` (\`endpoint_id\`, \`tenant_id\`, \`event_type\`, \`payload\`, \`status\`)
     VALUES (?, ?, ?, ?, 'pending')`,
    [input.endpointId, input.tenantId, input.eventType, input.payload],
  )
  return (result as any).insertId
}

export async function updateDeliveryResult(
  id: number,
  result: { status: WebhookDeliveryStatus; attempts: number; responseCode?: number | null; responseBody?: string | null; nextRetryAt?: Date | null },
): Promise<void> {
  await query(
    `UPDATE \`webhook_deliveries\`
       SET \`status\` = ?, \`attempts\` = ?, \`response_code\` = ?, \`response_body\` = ?,
           \`next_retry_at\` = ?, \`delivered_at\` = ${result.status === "success" ? "CURRENT_TIMESTAMP" : "NULL"}
     WHERE \`id\` = ?`,
    [
      result.status,
      result.attempts,
      result.responseCode ?? null,
      result.responseBody ? result.responseBody.slice(0, 500) : null,
      result.nextRetryAt ?? null,
      id,
    ],
  )
}

export async function listDeliveries(tenantId: number, endpointId?: number, limit = 50): Promise<WebhookDeliveryRow[]> {
  await ensureWebhooksSchema()
  if (endpointId) {
    return query<WebhookDeliveryRow[]>(
      `SELECT * FROM \`webhook_deliveries\` WHERE \`tenant_id\` = ? AND \`endpoint_id\` = ? ORDER BY \`created_at\` DESC LIMIT ?`,
      [tenantId, endpointId, limit],
    )
  }
  return query<WebhookDeliveryRow[]>(
    `SELECT * FROM \`webhook_deliveries\` WHERE \`tenant_id\` = ? ORDER BY \`created_at\` DESC LIMIT ?`,
    [tenantId, limit],
  )
}

/** Deliveries eligible for a retry sweep — failed, under the attempt cap, and past their backoff window. */
export async function listRetryableDeliveries(limit = 100): Promise<WebhookDeliveryRow[]> {
  await ensureWebhooksSchema()
  return query<WebhookDeliveryRow[]>(
    `SELECT * FROM \`webhook_deliveries\`
      WHERE \`status\` = 'failed' AND \`attempts\` < 5
        AND (\`next_retry_at\` IS NULL OR \`next_retry_at\` <= CURRENT_TIMESTAMP)
      ORDER BY \`created_at\` ASC LIMIT ?`,
    [limit],
  )
}

export async function getDeliveryEndpoint(endpointId: number): Promise<WebhookEndpointRow | null> {
  await ensureWebhooksSchema()
  const rows = await query<WebhookEndpointRow[]>(`SELECT * FROM \`webhook_endpoints\` WHERE \`id\` = ? LIMIT 1`, [
    endpointId,
  ])
  return rows[0] ?? null
}
