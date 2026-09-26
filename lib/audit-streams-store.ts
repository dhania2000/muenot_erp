import "server-only"
/**
 * Separated audit streams — server store (Spec47, #38-40, #209-212, #245-249).
 * ---------------------------------------------------------------------------
 * The tenant/platform-scoped data layer behind the pure model in
 * lib/audit-streams-model.ts. It does NOT introduce a fourth audit trail: it
 * READS the three existing append-only trails and projects them into the five
 * separated streams, then produces masked, retention/legal-hold-aware exports.
 *
 * Sources (all append-only, all owned by other modules):
 *   - audit_log_entries      (lib/audit-log-store.ts)      hashed, integrity-verifiable
 *   - security_audit_events  (lib/security-audit-store.ts) security events
 *   - platform_admin_audit   (lib/platform-roles.ts)       operator actions
 *
 * Every read is scoped by the viewer's authority using the pure rules
 * (canReadStream / buildAuditLogStreamWhere), so a tenant viewer can never see
 * another tenant's rows or the platform operator stream, and only a platform
 * super admin sees the cross-tenant security stream.
 */
import { query } from "@/lib/db"
import { recordAuditLog, type AuditContext } from "@/lib/audit-log-store"
import { getPlatformPolicy, getResolvedTenantPolicy, listLegalHolds } from "@/lib/audit-retention"
import type { AuditLegalHoldFilter } from "@/lib/audit-retention-policy"
import { effectiveTenantId, isImpersonating, type RoleContext } from "@/lib/role-model"
import {
  type AuditStream,
  type StreamRecord,
  type StreamViewer,
  type ExportRequest,
  type RetentionAnnotated,
  applyExportRetention,
  buildAuditLogStreamWhere,
  canReadStream,
  classifyAuditRow,
  computeExportDigest,
  exportFingerprint,
  maskStreamRecord,
  PLATFORM_SECURITY_ACTIONS,
  StreamAccessError,
  verifyAuditRowIntegrity,
} from "@/lib/audit-streams-model"

// ---------------------------------------------------------------------------
// Schema (self-healing export ledger; mirrors the migration)
// ---------------------------------------------------------------------------

let exportsReady: Promise<void> | null = null

export function ensureAuditExportSchema(): Promise<void> {
  if (!exportsReady) {
    exportsReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS \`security_audit_exports\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_scope\` INT UNSIGNED NOT NULL DEFAULT 0,
          \`stream\` VARCHAR(16) NOT NULL,
          \`masked\` TINYINT(1) NOT NULL DEFAULT 1,
          \`reason\` VARCHAR(500) NOT NULL,
          \`from_ts\` DATETIME(3) DEFAULT NULL,
          \`to_ts\` DATETIME(3) DEFAULT NULL,
          \`row_limit\` INT UNSIGNED NOT NULL DEFAULT 1000,
          \`filter_tenant_id\` INT UNSIGNED DEFAULT NULL,
          \`record_count\` INT UNSIGNED NOT NULL DEFAULT 0,
          \`excluded_by_retention\` INT UNSIGNED NOT NULL DEFAULT 0,
          \`held_count\` INT UNSIGNED NOT NULL DEFAULT 0,
          \`digest\` CHAR(64) NOT NULL,
          \`fingerprint\` CHAR(64) NOT NULL,
          \`idempotency_key\` VARCHAR(128) DEFAULT NULL,
          \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
          \`actor_email\` VARCHAR(190) DEFAULT NULL,
          \`viewer_kind\` VARCHAR(32) NOT NULL,
          \`created_at\` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uniq_export_idem\` (\`tenant_scope\`, \`idempotency_key\`),
          KEY \`idx_export_scope_stream\` (\`tenant_scope\`, \`stream\`),
          KEY \`idx_export_created\` (\`created_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `)
      await ensureExportImmutability()
    })().catch((err) => {
      exportsReady = null
      throw err
    })
  }
  return exportsReady
}

async function ensureExportImmutability(): Promise<void> {
  try {
    await query("DROP TRIGGER IF EXISTS `security_audit_exports_no_update`")
    await query(
      "CREATE TRIGGER `security_audit_exports_no_update` BEFORE UPDATE ON `security_audit_exports`" +
        " FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'security_audit_exports is append-only'",
    )
    await query("DROP TRIGGER IF EXISTS `security_audit_exports_no_delete`")
    await query(
      "CREATE TRIGGER `security_audit_exports_no_delete` BEFORE DELETE ON `security_audit_exports`" +
        " FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'security_audit_exports is append-only'",
    )
  } catch (err) {
    console.warn("[v0] audit export immutability triggers not installed (app-level immutability still applies):", (err as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (value == null) return new Date(0).toISOString()
  // MySQL DATETIME strings ("2027-02-17 10:00:00.000") parse fine via Date.
  const d = new Date(String(value).replace(" ", "T"))
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  if (typeof value === "object") return value as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function mapAuditLogRow(r: Row): StreamRecord {
  const tenantId = r.tenant_id == null ? null : Number(r.tenant_id)
  const action = String(r.action)
  const before = parseJson(r.before_data)
  const after = parseJson(r.after_data)
  const integrity = verifyAuditRowIntegrity({
    requestId: (r.request_id as string) ?? null,
    tenantId,
    actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
    sessionId: (r.session_id as string) ?? null,
    ipAddress: (r.ip_address as string) ?? null,
    action,
    entityType: (r.entity_type as string) ?? null,
    entityId: (r.entity_id as string) ?? null,
    result: String(r.result ?? "success"),
    before,
    after,
    integrityHash: (r.integrity_hash as string) ?? null,
  })
  return {
    source: "audit_log",
    sourceId: Number(r.id),
    stream: classifyAuditRow("audit_log", action, tenantId),
    tenantId,
    occurredAt: toIso(r.created_at),
    actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
    actorName: (r.actor_name as string) ?? null,
    actorEmail: (r.actor_email as string) ?? null,
    subject: (r.entity_label as string) ?? null,
    action,
    outcome: String(r.result ?? "success"),
    entityType: (r.entity_type as string) ?? null,
    entityId: (r.entity_id as string) ?? null,
    ipAddress: (r.ip_address as string) ?? null,
    userAgent: (r.user_agent as string) ?? null,
    detail: parseJson(r.metadata),
    integrity,
  }
}

function mapSecurityEventRow(r: Row): StreamRecord {
  const tenantId = r.tenant_id == null ? null : Number(r.tenant_id)
  return {
    source: "security_event",
    sourceId: Number(r.id),
    stream: "security",
    tenantId,
    occurredAt: toIso(r.created_at),
    actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
    actorName: (r.actor_name as string) ?? null,
    actorEmail: null,
    subject: (r.subject_email as string) ?? null,
    action: `${String(r.category)}.${String(r.action)}`,
    outcome: String(r.outcome ?? "info"),
    entityType: (r.category as string) ?? null,
    entityId: null,
    ipAddress: (r.ip_address as string) ?? null,
    userAgent: null,
    detail: parseJson(r.detail),
    integrity: "unsigned",
  }
}

function mapPlatformAdminRow(r: Row): StreamRecord {
  const tenantId = r.target_tenant_id == null ? null : Number(r.target_tenant_id)
  const action = String(r.action)
  return {
    source: "platform_admin",
    sourceId: Number(r.id),
    stream: classifyAuditRow("platform_admin", action, tenantId),
    tenantId,
    occurredAt: toIso(r.created_at),
    actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
    actorName: null,
    actorEmail: (r.actor_email as string) ?? null,
    subject: r.target_user_id == null ? null : String(r.target_user_id),
    action,
    outcome: "info",
    entityType: "platform_admin",
    entityId: tenantId == null ? null : String(tenantId),
    ipAddress: null,
    userAgent: null,
    detail: parseJson(r.detail),
    integrity: "unsigned",
  }
}

// ---------------------------------------------------------------------------
// Reading a stream projection
// ---------------------------------------------------------------------------

export type StreamListOptions = {
  from?: string | null
  to?: string | null
  limit?: number
  /** Platform viewers may narrow to one tenant; ignored for tenant viewers. */
  filterTenantId?: number | null
}

function dateFilterSql(column: string, from: string | null | undefined, to: string | null | undefined): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  if (from) {
    parts.push(`\`${column}\` >= ?`)
    params.push(new Date(from))
  }
  if (to) {
    parts.push(`\`${column}\` <= ?`)
    params.push(new Date(to))
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params }
}

/** Effective tenant filter for the non-hashed sources, mirroring the model's audit_log scoping. */
function sourceTenantScope(
  column: string,
  viewer: StreamViewer,
  filterTenantId: number | null | undefined,
): { sql: string; params: unknown[] } {
  if (viewer.kind === "tenant_admin") return { sql: ` AND \`${column}\` = ?`, params: [viewer.tenantId] }
  if (filterTenantId != null) return { sql: ` AND \`${column}\` = ?`, params: [filterTenantId] }
  return { sql: "", params: [] }
}

/**
 * List one stream's normalized records for a viewer, newest first. Throws
 * StreamAccessError when the viewer may not read the stream.
 */
export async function listStreamRecords(
  stream: AuditStream,
  viewer: StreamViewer,
  opts: StreamListOptions = {},
): Promise<StreamRecord[]> {
  if (!canReadStream(viewer, stream)) throw new StreamAccessError("You may not read this audit stream")
  await ensureAuditExportSchema()
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 5000)
  const out: StreamRecord[] = []

  // Source 1 — audit_log_entries (all streams flow from here).
  {
    const where = buildAuditLogStreamWhere(stream, viewer, opts.filterTenantId ?? null)
    const df = dateFilterSql("created_at", opts.from, opts.to)
    try {
      const rows = (await query(
        `SELECT * FROM \`audit_log_entries\` ${where.sql}${df.sql} ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ?`,
        [...where.params, ...df.params, limit],
      )) as Row[]
      for (const r of rows) out.push(mapAuditLogRow(r))
    } catch (err) {
      if (!isMissingTable(err)) throw err
    }
  }

  // Source 2 — security_audit_events (only the security stream).
  if (stream === "security") {
    const scope = sourceTenantScope("tenant_id", viewer, opts.filterTenantId)
    const df = dateFilterSql("created_at", opts.from, opts.to)
    try {
      const rows = (await query(
        `SELECT * FROM \`security_audit_events\` WHERE 1=1${scope.sql}${df.sql} ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ?`,
        [...scope.params, ...df.params, limit],
      )) as Row[]
      for (const r of rows) out.push(mapSecurityEventRow(r))
    } catch (err) {
      if (!isMissingTable(err)) throw err
    }
  }

  // Source 3 — platform_admin_audit (platform stream, or security stream for
  // privileged-access operator actions). Never surfaced to platform_staff on
  // the security stream because canReadStream already gated that above.
  if (stream === "platform" || stream === "security") {
    const scope = sourceTenantScope("target_tenant_id", viewer, opts.filterTenantId)
    const df = dateFilterSql("created_at", opts.from, opts.to)
    const actionClause =
      stream === "security"
        ? ` AND \`action\` IN (${PLATFORM_SECURITY_ACTIONS.map(() => "?").join(",")})`
        : ` AND \`action\` NOT IN (${PLATFORM_SECURITY_ACTIONS.map(() => "?").join(",")})`
    try {
      const rows = (await query(
        `SELECT * FROM \`platform_admin_audit\` WHERE 1=1${scope.sql}${actionClause}${df.sql} ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ?`,
        [...scope.params, ...PLATFORM_SECURITY_ACTIONS, ...df.params, limit],
      )) as Row[]
      for (const r of rows) out.push(mapPlatformAdminRow(r))
    } catch (err) {
      if (!isMissingTable(err)) throw err
    }
  }

  out.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : b.sourceId - a.sourceId))
  return out.slice(0, limit)
}

function isMissingTable(err: unknown): boolean {
  return Number((err as { errno?: number })?.errno ?? 0) === 1146
}

// ---------------------------------------------------------------------------
// Exports (masking + retention + legal hold + tamper-evident digest)
// ---------------------------------------------------------------------------

export type ExportResult = {
  ok: true
  id: number
  replayed: boolean
  digest: string
  recordCount: number
  excludedByRetention: number
  heldCount: number
  records: RetentionAnnotated[]
  masked: boolean
  stream: AuditStream
}

/**
 * Produce an export of a stream for a viewer: read → apply retention + legal
 * holds → mask → hash-chain digest → record an append-only ledger row. Idempotent
 * by (scope, idempotencyKey): a replay with the SAME request returns the existing
 * ledger row; a replay with a DIFFERENT request under the same key is rejected.
 */
export async function createStreamExport(
  viewer: StreamViewer,
  req: ExportRequest,
  meta: { actorUserId: number; actorEmail: string; idempotencyKey?: string | null; audit?: AuditContext },
): Promise<ExportResult> {
  if (!canReadStream(viewer, req.stream)) throw new StreamAccessError("You may not export this audit stream")
  await ensureAuditExportSchema()

  const scope = viewer.kind === "tenant_admin" ? viewer.tenantId : 0
  const fingerprint = exportFingerprint(req)

  // Idempotency: an existing ledger row under this key short-circuits.
  if (meta.idempotencyKey) {
    const existing = (await query(
      `SELECT * FROM \`security_audit_exports\` WHERE \`tenant_scope\` = ? AND \`idempotency_key\` = ? LIMIT 1`,
      [scope, meta.idempotencyKey],
    )) as Row[]
    if (existing.length) {
      const row = existing[0]
      if (String(row.fingerprint) !== fingerprint) {
        throw new StreamAccessError("This idempotency key was already used for a different export request", 409)
      }
      const replay = await buildExportPayload(viewer, req)
      return {
        ok: true,
        id: Number(row.id),
        replayed: true,
        digest: String(row.digest),
        recordCount: Number(row.record_count),
        excludedByRetention: Number(row.excluded_by_retention),
        heldCount: Number(row.held_count),
        records: replay.kept,
        masked: req.masked,
        stream: req.stream,
      }
    }
  }

  const payload = await buildExportPayload(viewer, req)

  const insert = (await query(
    `INSERT INTO \`security_audit_exports\`
       (\`tenant_scope\`, \`stream\`, \`masked\`, \`reason\`, \`from_ts\`, \`to_ts\`, \`row_limit\`,
        \`filter_tenant_id\`, \`record_count\`, \`excluded_by_retention\`, \`held_count\`,
        \`digest\`, \`fingerprint\`, \`idempotency_key\`, \`actor_user_id\`, \`actor_email\`, \`viewer_kind\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope,
      req.stream,
      req.masked ? 1 : 0,
      req.reason,
      req.from ? new Date(req.from) : null,
      req.to ? new Date(req.to) : null,
      req.limit,
      req.tenantId,
      payload.kept.length,
      payload.excludedByRetention,
      payload.heldCount,
      payload.digest,
      fingerprint,
      meta.idempotencyKey ?? null,
      meta.actorUserId,
      meta.actorEmail,
      viewer.kind,
    ],
  )) as { insertId?: number }

  // A security export is itself a security-relevant action: record it in the
  // immutable audit log (which lands back in the security stream by taxonomy).
  await recordAuditLog(
    {
      action: "security.audit_export",
      result: "success",
      entityType: "security_audit_export",
      entityId: String(insert.insertId ?? 0),
      metadata: {
        stream: req.stream,
        masked: req.masked,
        recordCount: payload.kept.length,
        excludedByRetention: payload.excludedByRetention,
        heldCount: payload.heldCount,
        digest: payload.digest,
        reason: req.reason,
        filterTenantId: req.tenantId,
      },
    },
    meta.audit,
  )

  return {
    ok: true,
    id: Number(insert.insertId ?? 0),
    replayed: false,
    digest: payload.digest,
    recordCount: payload.kept.length,
    excludedByRetention: payload.excludedByRetention,
    heldCount: payload.heldCount,
    records: payload.kept,
    masked: req.masked,
    stream: req.stream,
  }
}

async function buildExportPayload(
  viewer: StreamViewer,
  req: ExportRequest,
): Promise<{ kept: RetentionAnnotated[]; excludedByRetention: number; heldCount: number; digest: string }> {
  const records = await listStreamRecords(req.stream, viewer, {
    from: req.from,
    to: req.to,
    limit: req.limit,
    filterTenantId: req.tenantId,
  })

  // Retention scope: a tenant viewer uses its own resolved policy; a platform
  // viewer uses the narrowed tenant's policy when filtering to one, else the
  // platform default. Legal holds are stored under the same scope id (0 = platform).
  const retentionScope = viewer.kind === "tenant_admin" ? viewer.tenantId : (req.tenantId ?? 0)
  const retentionDays =
    retentionScope > 0
      ? await getResolvedTenantPolicy(retentionScope)
          .then((p) => p.retentionDays)
          .catch(() => 3650)
      : await getPlatformPolicy()
          .then((p) => p.defaultRetentionDays)
          .catch(() => 3650)
  const holds: AuditLegalHoldFilter[] = await listLegalHolds(retentionScope)
    .then((hs) => hs.filter((h) => h.status === "active").map((h) => h.filter))
    .catch(() => [])

  const { kept, excludedByRetention, heldCount } = applyExportRetention(records, {
    retentionDays,
    holds,
  })

  const masked = kept.map((r) => ({ ...maskStreamRecord(r, req.masked), legalHold: r.legalHold }))
  const digest = computeExportDigest(masked)
  return { kept: masked as RetentionAnnotated[], excludedByRetention, heldCount, digest }
}

// ---------------------------------------------------------------------------
// Export ledger listing (read-only)
// ---------------------------------------------------------------------------

export type ExportLedgerEntry = {
  id: number
  stream: string
  masked: boolean
  reason: string
  recordCount: number
  excludedByRetention: number
  heldCount: number
  digest: string
  actorEmail: string | null
  viewerKind: string
  filterTenantId: number | null
  createdAt: string
}

export async function listStreamExports(viewer: StreamViewer, limit = 100): Promise<ExportLedgerEntry[]> {
  await ensureAuditExportSchema()
  const scope = viewer.kind === "tenant_admin" ? viewer.tenantId : 0
  const rows = (await query(
    `SELECT * FROM \`security_audit_exports\` WHERE \`tenant_scope\` = ? ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ?`,
    [scope, Math.min(Math.max(limit, 1), 500)],
  )) as Row[]
  return rows.map((r) => ({
    id: Number(r.id),
    stream: String(r.stream),
    masked: Boolean(Number(r.masked)),
    reason: String(r.reason),
    recordCount: Number(r.record_count),
    excludedByRetention: Number(r.excluded_by_retention),
    heldCount: Number(r.held_count),
    digest: String(r.digest),
    actorEmail: (r.actor_email as string) ?? null,
    viewerKind: String(r.viewer_kind),
    filterTenantId: r.filter_tenant_id == null ? null : Number(r.filter_tenant_id),
    createdAt: toIso(r.created_at),
  }))
}

// ---------------------------------------------------------------------------
// Viewer construction from an authorization context
// ---------------------------------------------------------------------------

/**
 * Build the tenant-side viewer. The tenant is ALWAYS the effective (session)
 * tenant — never client-supplied — so a tenant admin can only ever read/export
 * their own tenant's streams. isOwner is false while impersonating, so an
 * impersonating operator can never produce an unmasked export.
 */
export function tenantStreamViewer(ctx: RoleContext): StreamViewer {
  const tenantId = effectiveTenantId(ctx)
  if (tenantId == null) throw new StreamAccessError("No tenant in context")
  const isOwner = !isImpersonating(ctx) && ctx.tenantRole === "tenant_owner"
  return { kind: "tenant_admin", tenantId, isOwner }
}

/** Build the platform-side viewer from the resolved platform role. */
export function platformStreamViewer(ctx: RoleContext): StreamViewer {
  return ctx.platformRole === "platform_super_admin" ? { kind: "platform_super_admin" } : { kind: "platform_staff" }
}
