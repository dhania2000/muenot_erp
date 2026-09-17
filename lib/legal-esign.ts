import "server-only"
import crypto from "crypto"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import type {
  EsignRequest,
  EsignSigner,
  EsignField,
  EsignEvent,
  EsignStats,
  SignerType,
  SigningType,
  EsignSource,
  FieldType,
} from "@/lib/legal-esign-shared"

// ---------------------------------------------------------------------------
// Legal E-sign — core server library (server-only).
//
// Owns the self-healing schema, secure DB-backed file storage (signature images
// + generated PDFs, never a public URL), secure single-use signing tokens,
// request / signer / field persistence, the immutable audit trail and the
// dashboard aggregates. Reuses the existing contract, employee, client and
// vendor masters — it never creates a parallel document or party store.
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

/** Idempotently create every E-sign table. Safe to call on every request. */
export function ensureEsignTables(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure() {
  // Secure blob store for signature images AND generated PDFs. Rows are served
  // only through auth-gated / token-scoped routes — never a public URL.
  await query(`CREATE TABLE IF NOT EXISTS legal_esign_files (
    id VARCHAR(40) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'signature',
    filename VARCHAR(255) DEFAULT NULL,
    content_type VARCHAR(150) DEFAULT NULL,
    size INT UNSIGNED DEFAULT NULL,
    data LONGBLOB NOT NULL,
    created_by INT UNSIGNED DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_esign_files_kind (kind)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS legal_esign_signatories (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    signatory_uid VARCHAR(40) NOT NULL,
    employee_id INT UNSIGNED DEFAULT NULL,
    name VARCHAR(190) NOT NULL,
    designation VARCHAR(190) DEFAULT NULL,
    department VARCHAR(190) DEFAULT NULL,
    email VARCHAR(190) DEFAULT NULL,
    signature_file_id VARCHAR(40) DEFAULT NULL,
    signature_status VARCHAR(20) NOT NULL DEFAULT 'None',
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    default_scope VARCHAR(40) DEFAULT NULL,
    created_by INT UNSIGNED DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_signatory_uid (signatory_uid),
    KEY idx_signatory_employee (employee_id),
    KEY idx_signatory_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS legal_esign_signatory_versions (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    signatory_id INT UNSIGNED NOT NULL,
    signature_file_id VARCHAR(40) DEFAULT NULL,
    note VARCHAR(255) DEFAULT NULL,
    changed_by INT UNSIGNED DEFAULT NULL,
    changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_sig_version_signatory (signatory_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS legal_esign_requests (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    request_uid VARCHAR(40) NOT NULL,
    title VARCHAR(255) NOT NULL,
    document_source VARCHAR(40) NOT NULL DEFAULT 'contract',
    contract_id INT UNSIGNED DEFAULT NULL,
    template_id INT UNSIGNED DEFAULT NULL,
    template_version INT UNSIGNED DEFAULT NULL,
    source_module VARCHAR(40) DEFAULT NULL,
    source_record_id VARCHAR(64) DEFAULT NULL,
    signing_type VARCHAR(12) NOT NULL DEFAULT 'sequential',
    status VARCHAR(24) NOT NULL DEFAULT 'Draft',
    due_date DATE DEFAULT NULL,
    message TEXT DEFAULT NULL,
    auto_email_signed TINYINT(1) NOT NULL DEFAULT 0,
    require_confirm TINYINT(1) NOT NULL DEFAULT 1,
    base_file_id VARCHAR(40) DEFAULT NULL,
    signed_file_id VARCHAR(40) DEFAULT NULL,
    cancel_reason VARCHAR(500) DEFAULT NULL,
    created_by INT UNSIGNED DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    sent_at DATETIME DEFAULT NULL,
    completed_at DATETIME DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_request_uid (request_uid),
    KEY idx_request_status (status),
    KEY idx_request_contract (contract_id),
    KEY idx_request_source (document_source, source_record_id),
    KEY idx_request_due (due_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS legal_esign_signers (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    request_id INT UNSIGNED NOT NULL,
    signer_uid VARCHAR(40) NOT NULL,
    signer_type VARCHAR(30) NOT NULL,
    ref_id VARCHAR(64) DEFAULT NULL,
    signatory_id INT UNSIGNED DEFAULT NULL,
    name VARCHAR(190) NOT NULL,
    email VARCHAR(190) NOT NULL,
    mobile VARCHAR(40) DEFAULT NULL,
    role VARCHAR(80) DEFAULT NULL,
    signing_order INT NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'Pending',
    token_hash VARCHAR(64) DEFAULT NULL,
    token_expires_at DATETIME DEFAULT NULL,
    token_used TINYINT(1) NOT NULL DEFAULT 0,
    signature_method VARCHAR(20) DEFAULT NULL,
    signature_file_id VARCHAR(40) DEFAULT NULL,
    viewed_at DATETIME DEFAULT NULL,
    signed_at DATETIME DEFAULT NULL,
    rejected_at DATETIME DEFAULT NULL,
    reject_reason VARCHAR(500) DEFAULT NULL,
    sign_ip VARCHAR(60) DEFAULT NULL,
    sign_user_agent VARCHAR(400) DEFAULT NULL,
    confirmed TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_signer_uid (signer_uid),
    KEY idx_signer_request (request_id),
    KEY idx_signer_token (token_hash),
    KEY idx_signer_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS legal_esign_fields (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    request_id INT UNSIGNED NOT NULL,
    signer_id INT UNSIGNED NOT NULL,
    field_type VARCHAR(20) NOT NULL,
    page INT NOT NULL DEFAULT 1,
    pos_x FLOAT NOT NULL DEFAULT 0,
    pos_y FLOAT NOT NULL DEFAULT 0,
    width FLOAT NOT NULL DEFAULT 0.22,
    height FLOAT NOT NULL DEFAULT 0.06,
    value VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_field_request (request_id),
    KEY idx_field_signer (signer_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS legal_esign_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    request_id INT UNSIGNED NOT NULL,
    signer_id INT UNSIGNED DEFAULT NULL,
    event_type VARCHAR(60) NOT NULL,
    summary VARCHAR(300) NOT NULL,
    detail JSON DEFAULT NULL,
    actor_id INT UNSIGNED DEFAULT NULL,
    actor_name VARCHAR(150) DEFAULT NULL,
    ip VARCHAR(60) DEFAULT NULL,
    user_agent VARCHAR(400) DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_event_request (request_id, created_at),
    KEY idx_event_type (event_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Cron reminder ledger — one row per (signer, reminder key) makes repeated
  // cron runs idempotent (Phase 94).
  await query(`CREATE TABLE IF NOT EXISTS legal_esign_reminders (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    request_id INT UNSIGNED NOT NULL,
    signer_id INT UNSIGNED NOT NULL,
    reminder_key VARCHAR(40) NOT NULL,
    sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_reminder (signer_id, reminder_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

// --- Secure file storage ----------------------------------------------------

export type StoredFile = { id: string; filename: string | null; content_type: string | null; size: number | null }

/** Persist a binary blob (signature image or PDF) and return its opaque id. */
export async function storeEsignFile(input: {
  kind: "signature" | "pdf"
  data: Buffer
  filename?: string | null
  contentType?: string | null
  createdBy?: number | null
}): Promise<string> {
  await ensureEsignTables()
  const id = crypto.randomUUID()
  await query(
    `INSERT INTO legal_esign_files (id, kind, filename, content_type, size, data, created_by) VALUES (?,?,?,?,?,?,?)`,
    [id, input.kind, input.filename ?? null, input.contentType ?? null, input.data.length, input.data, input.createdBy ?? null],
  )
  return id
}

export async function getEsignFile(
  id: string,
): Promise<{ data: Buffer; content_type: string | null; filename: string | null; kind: string } | null> {
  if (!id) return null
  await ensureEsignTables()
  const rows = await query<any[]>(
    `SELECT data, content_type, filename, kind FROM legal_esign_files WHERE id = ? LIMIT 1`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data)
  return { data, content_type: row.content_type ?? null, filename: row.filename ?? null, kind: row.kind }
}

// --- Secure tokens ----------------------------------------------------------

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex")
}

/** Fresh, unguessable signing token. Only its hash is ever stored. */
export function generateSignToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("base64url")
  return { raw, hash: hashToken(raw) }
}

// --- Audit trail ------------------------------------------------------------

export async function logEsignEvent(opts: {
  requestId: number
  signerId?: number | null
  type: string
  summary: string
  detail?: Record<string, unknown> | null
  actorId?: number | null
  actorName?: string | null
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  try {
    await ensureEsignTables()
    await query(
      `INSERT INTO legal_esign_events
         (request_id, signer_id, event_type, summary, detail, actor_id, actor_name, ip, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        opts.requestId,
        opts.signerId ?? null,
        opts.type,
        opts.summary,
        opts.detail && Object.keys(opts.detail).length ? JSON.stringify(opts.detail) : null,
        opts.actorId ?? null,
        opts.actorName ?? null,
        opts.ip ?? null,
        opts.userAgent ?? null,
      ],
    )
  } catch (error) {
    console.error("[v0] logEsignEvent failed:", (error as Error).message)
  }
}

function parseDetail(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === "object") return value as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

export async function getEsignEvents(requestId: number): Promise<EsignEvent[]> {
  await ensureEsignTables()
  const rows = await query<any[]>(
    `SELECT e.*, u.name AS actor_display FROM legal_esign_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.request_id = ? ORDER BY e.created_at DESC, e.id DESC`,
    [requestId],
  ).catch(() =>
    query<any[]>(`SELECT * FROM legal_esign_events WHERE request_id = ? ORDER BY created_at DESC, id DESC`, [requestId]),
  )
  return rows.map((r) => ({
    id: Number(r.id),
    request_id: Number(r.request_id),
    signer_id: r.signer_id != null ? Number(r.signer_id) : null,
    event_type: r.event_type,
    summary: r.summary,
    detail: parseDetail(r.detail),
    actor_id: r.actor_id != null ? Number(r.actor_id) : null,
    actor_name: r.actor_name || r.actor_display || null,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  }))
}

// --- Requests ---------------------------------------------------------------

export type CreateRequestInput = {
  title: string
  documentSource: EsignSource
  contractId?: number | null
  templateId?: number | null
  templateVersion?: number | null
  sourceModule?: string | null
  sourceRecordId?: string | null
  signingType?: SigningType
  dueDate?: string | null
  message?: string | null
  autoEmailSigned?: boolean
  requireConfirm?: boolean
  createdBy?: number | null
  createdByName?: string | null
}

export async function createEsignRequest(input: CreateRequestInput): Promise<EsignRequest> {
  await ensureEsignTables()
  const uid = await nextRecordId("ESR", { allowCustom: true })
  const result = await query<any>(
    `INSERT INTO legal_esign_requests
       (request_uid, title, document_source, contract_id, template_id, template_version,
        source_module, source_record_id, signing_type, status, due_date, message,
        auto_email_signed, require_confirm, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      uid,
      input.title,
      input.documentSource,
      input.contractId ?? null,
      input.templateId ?? null,
      input.templateVersion ?? null,
      input.sourceModule ?? null,
      input.sourceRecordId ?? null,
      input.signingType || "sequential",
      "Draft",
      input.dueDate || null,
      input.message ?? null,
      input.autoEmailSigned ? 1 : 0,
      input.requireConfirm === false ? 0 : 1,
      input.createdBy ?? null,
    ],
  )
  const id = Number((result as any).insertId)
  await logEsignEvent({
    requestId: id,
    type: "request_created",
    summary: `E-sign request created for “${input.title}”`,
    detail: { source: input.documentSource, contractId: input.contractId ?? null },
    actorId: input.createdBy ?? null,
    actorName: input.createdByName ?? null,
  })
  const req = await getEsignRequest(id)
  return req as EsignRequest
}

/**
 * Guard against accidental duplicate requests: an OPEN (non-terminal) request
 * already covering the same contract/source. Callers may force a new one.
 */
export async function findOpenRequestForSource(input: {
  contractId?: number | null
  documentSource: string
  sourceRecordId?: string | null
}): Promise<number | null> {
  await ensureEsignTables()
  const terminal = "('Completed','Rejected','Cancelled','Expired')"
  if (input.contractId) {
    const rows = await query<any[]>(
      `SELECT id FROM legal_esign_requests WHERE contract_id = ? AND status NOT IN ${terminal} LIMIT 1`,
      [input.contractId],
    )
    if (rows[0]) return Number(rows[0].id)
  }
  if (input.sourceRecordId) {
    const rows = await query<any[]>(
      `SELECT id FROM legal_esign_requests
        WHERE document_source = ? AND source_record_id = ? AND status NOT IN ${terminal} LIMIT 1`,
      [input.documentSource, input.sourceRecordId],
    )
    if (rows[0]) return Number(rows[0].id)
  }
  return null
}

export async function getEsignRequest(id: number): Promise<EsignRequest | null> {
  await ensureEsignTables()
  const rows = await query<any[]>(
    `SELECT r.*, u.name AS created_by_name, c.reference_no AS contract_reference
       FROM legal_esign_requests r
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN legal_generated_contracts c ON c.id = r.contract_id
      WHERE r.id = ? LIMIT 1`,
    [id],
  ).catch(() =>
    query<any[]>(`SELECT * FROM legal_esign_requests WHERE id = ? LIMIT 1`, [id]),
  )
  const r = rows[0]
  if (!r) return null
  const signers = await getRequestSigners(id)
  return { ...r, signers } as EsignRequest
}

export async function getRequestSigners(requestId: number): Promise<EsignSigner[]> {
  const rows = await query<any[]>(
    `SELECT * FROM legal_esign_signers WHERE request_id = ? ORDER BY signing_order ASC, id ASC`,
    [requestId],
  )
  const fields = await query<any[]>(
    `SELECT * FROM legal_esign_fields WHERE request_id = ? ORDER BY id ASC`,
    [requestId],
  )
  return rows.map((s) => ({
    ...s,
    fields: fields.filter((f) => Number(f.signer_id) === Number(s.id)),
  })) as EsignSigner[]
}

export type RequestListFilters = {
  search?: string
  status?: string
  source?: string
  signerType?: string
  dueBefore?: string
  dueAfter?: string
  limit?: number
  offset?: number
}

export async function listEsignRequests(
  filters: RequestListFilters = {},
): Promise<{ rows: EsignRequest[]; total: number }> {
  await ensureEsignTables()
  const where: string[] = []
  const params: any[] = []
  if (filters.search) {
    const like = `%${filters.search}%`
    where.push(
      `(r.title LIKE ? OR r.request_uid LIKE ? OR r.contract_id IN
         (SELECT id FROM legal_generated_contracts WHERE reference_no LIKE ? OR contract_uid LIKE ? OR party_name LIKE ?)
        OR r.id IN (SELECT request_id FROM legal_esign_signers WHERE name LIKE ? OR email LIKE ?))`,
    )
    params.push(like, like, like, like, like, like, like)
  }
  if (filters.status && filters.status !== "all") {
    where.push("r.status = ?")
    params.push(filters.status)
  }
  if (filters.source && filters.source !== "all") {
    where.push("r.document_source = ?")
    params.push(filters.source)
  }
  if (filters.signerType && filters.signerType !== "all") {
    where.push("r.id IN (SELECT request_id FROM legal_esign_signers WHERE signer_type = ?)")
    params.push(filters.signerType)
  }
  if (filters.dueAfter) {
    where.push("r.due_date >= ?")
    params.push(filters.dueAfter)
  }
  if (filters.dueBefore) {
    where.push("r.due_date <= ?")
    params.push(filters.dueBefore)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)
  const offset = Math.max(filters.offset ?? 0, 0)

  const rows = await query<any[]>(
    `SELECT r.*, u.name AS created_by_name, c.reference_no AS contract_reference
       FROM legal_esign_requests r
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN legal_generated_contracts c ON c.id = r.contract_id
       ${whereSql}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ).catch(() =>
    query<any[]>(
      `SELECT r.* FROM legal_esign_requests r ${whereSql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  )
  const countRows = await query<any[]>(`SELECT COUNT(*) AS n FROM legal_esign_requests r ${whereSql}`, params)
  const withSigners = await Promise.all(
    rows.map(async (r) => ({ ...r, signers: await getRequestSigners(Number(r.id)) })),
  )
  return { rows: withSigners as EsignRequest[], total: Number(countRows[0]?.n || 0) }
}

export async function esignStats(): Promise<EsignStats> {
  await ensureEsignTables()
  const rows = await query<any[]>(
    `SELECT
       COUNT(*) AS total,
       SUM(status IN ('Sent','Viewed','Awaiting Signature')) AS awaiting,
       SUM(status = 'Completed') AS completed,
       SUM(status = 'Partially Signed') AS partially,
       SUM(status = 'Rejected') AS rejected,
       SUM(status = 'Expired') AS expired,
       SUM(status = 'Cancelled') AS cancelled,
       SUM(status = 'Draft') AS draft
     FROM legal_esign_requests`,
  ).catch(() => [{}])
  const r = rows[0] || {}
  return {
    total: Number(r.total || 0),
    awaiting: Number(r.awaiting || 0),
    completed: Number(r.completed || 0),
    partiallySigned: Number(r.partially || 0),
    rejected: Number(r.rejected || 0),
    expired: Number(r.expired || 0),
    cancelled: Number(r.cancelled || 0),
    draft: Number(r.draft || 0),
  }
}

// --- Signers ----------------------------------------------------------------

export type SignerInput = {
  signerType: SignerType
  refId?: string | null
  signatoryId?: number | null
  name: string
  email: string
  mobile?: string | null
  role?: string | null
  signingOrder?: number | null
}

export async function addSigner(requestId: number, input: SignerInput): Promise<EsignSigner> {
  await ensureEsignTables()
  const uid = await nextRecordId("ESS", { allowCustom: true })
  const orderRow = await query<any[]>(
    `SELECT COALESCE(MAX(signing_order),0)+1 AS next FROM legal_esign_signers WHERE request_id = ?`,
    [requestId],
  )
  const order = input.signingOrder ?? Number(orderRow[0]?.next || 1)
  const result = await query<any>(
    `INSERT INTO legal_esign_signers
       (request_id, signer_uid, signer_type, ref_id, signatory_id, name, email, mobile, role, signing_order, status)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'Pending')`,
    [
      requestId,
      uid,
      input.signerType,
      input.refId ?? null,
      input.signatoryId ?? null,
      input.name,
      input.email,
      input.mobile ?? null,
      input.role ?? null,
      order,
    ],
  )
  const id = Number((result as any).insertId)
  const rows = await query<any[]>(`SELECT * FROM legal_esign_signers WHERE id = ? LIMIT 1`, [id])
  return { ...rows[0], fields: [] } as EsignSigner
}

export async function removeSigner(requestId: number, signerId: number): Promise<void> {
  await query(`DELETE FROM legal_esign_fields WHERE signer_id = ? AND request_id = ?`, [signerId, requestId])
  await query(`DELETE FROM legal_esign_signers WHERE id = ? AND request_id = ?`, [signerId, requestId])
}

export async function getSigner(signerId: number): Promise<EsignSigner | null> {
  const rows = await query<any[]>(`SELECT * FROM legal_esign_signers WHERE id = ? LIMIT 1`, [signerId])
  if (!rows[0]) return null
  const fields = await query<any[]>(`SELECT * FROM legal_esign_fields WHERE signer_id = ? ORDER BY id ASC`, [signerId])
  return { ...rows[0], fields } as EsignSigner
}

/**
 * Resolve a signing token to its signer + request, enforcing every gate
 * (Phase 32): valid token, known signer/request, non-terminal request status,
 * unused single-use token and unexpired link. Never trusts a browser identity.
 */
export async function resolveSignerByToken(rawToken: string): Promise<
  | { ok: true; signer: EsignSigner; request: EsignRequest }
  | { ok: false; reason: "invalid" | "expired" | "used" | "closed" }
> {
  await ensureEsignTables()
  if (!rawToken) return { ok: false, reason: "invalid" }
  const hash = hashToken(rawToken)
  const rows = await query<any[]>(`SELECT * FROM legal_esign_signers WHERE token_hash = ? LIMIT 1`, [hash])
  const signerRow = rows[0]
  if (!signerRow) return { ok: false, reason: "invalid" }
  const request = await getEsignRequest(Number(signerRow.request_id))
  if (!request) return { ok: false, reason: "invalid" }
  if (["Cancelled", "Expired", "Rejected"].includes(request.status)) return { ok: false, reason: "closed" }
  if (signerRow.token_used || signerRow.status === "Signed") return { ok: false, reason: "used" }
  if (signerRow.token_expires_at && new Date(signerRow.token_expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" }
  }
  const fields = await query<any[]>(`SELECT * FROM legal_esign_fields WHERE signer_id = ? ORDER BY id ASC`, [
    signerRow.id,
  ])
  return { ok: true, signer: { ...signerRow, fields } as EsignSigner, request }
}

// --- Fields -----------------------------------------------------------------

export type FieldInput = {
  signerId: number
  fieldType: FieldType
  page?: number
  x: number
  y: number
  width?: number
  height?: number
  value?: string | null
}

/** Replace ALL fields for a request in one transaction-like sweep. */
export async function replaceFields(requestId: number, fields: FieldInput[]): Promise<void> {
  await ensureEsignTables()
  await query(`DELETE FROM legal_esign_fields WHERE request_id = ?`, [requestId])
  for (const f of fields) {
    await query(
      `INSERT INTO legal_esign_fields (request_id, signer_id, field_type, page, pos_x, pos_y, width, height, value)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        requestId,
        f.signerId,
        f.fieldType,
        f.page ?? 1,
        f.x,
        f.y,
        f.width ?? 0.22,
        f.height ?? 0.06,
        f.value ?? null,
      ],
    )
  }
}

// --- Status recompute -------------------------------------------------------

/**
 * Recompute the request status from its signers. The single source of truth for
 * the umbrella status — called after every signer transition so the dashboard
 * and cron never disagree. Returns the new status.
 */
export async function recomputeRequestStatus(requestId: number): Promise<string> {
  const req = await query<any[]>(`SELECT * FROM legal_esign_requests WHERE id = ? LIMIT 1`, [requestId])
  const r = req[0]
  if (!r) return "Draft"
  if (["Cancelled", "Expired"].includes(r.status)) return r.status
  const signers = await query<any[]>(`SELECT status FROM legal_esign_signers WHERE request_id = ?`, [requestId])
  if (signers.length === 0) return r.status

  const statuses = signers.map((s) => s.status)
  let next = r.status
  if (statuses.includes("Rejected")) {
    next = "Rejected"
  } else if (statuses.every((s) => s === "Signed")) {
    next = "Completed"
  } else if (statuses.some((s) => s === "Signed")) {
    next = "Partially Signed"
  } else if (statuses.some((s) => s === "Viewed")) {
    next = "Viewed"
  } else if (statuses.some((s) => s === "Sent")) {
    next = "Awaiting Signature"
  } else {
    next = r.status === "Draft" ? "Draft" : "Awaiting Signature"
  }

  const completedAt = next === "Completed" ? new Date() : null
  await query(
    `UPDATE legal_esign_requests SET status = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?`,
    [next, completedAt, requestId],
  )
  return next
}

/** True when it's this signer's turn (parallel = always; sequential = lowest unsigned order). */
export async function isSignerTurn(request: EsignRequest, signer: EsignSigner): Promise<boolean> {
  if (request.signing_type === "parallel") return true
  const rows = await query<any[]>(
    `SELECT signing_order, status FROM legal_esign_signers WHERE request_id = ? ORDER BY signing_order ASC`,
    [request.id],
  )
  const firstPending = rows.find((r) => r.status !== "Signed" && r.status !== "Rejected")
  if (!firstPending) return false
  return Number(firstPending.signing_order) === Number(signer.signing_order)
}
