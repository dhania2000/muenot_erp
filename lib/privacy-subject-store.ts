import "server-only"
/**
 * Spec24 — Data-subject request (DSAR) store.
 * ---------------------------------------------------------------------------
 * Persists and executes the three subject-rights workflows — export,
 * anonymize, erase — over one person's personal data, which lives across the
 * tables in lib/privacy-subject-catalog.ts.
 *
 * The hard guarantees, all enforced server-side and tenant-scoped:
 *   - LEGAL HOLD is absolute: a location covered by an active legal hold is
 *     never touched, mirroring lib/retention-engine.ts. It consults the SAME
 *     getPolicyHoldCoverage() the retention sweep uses.
 *   - RETENTION obligations downgrade an erase to an anonymize: if an active
 *     retention policy governs a location, the row is kept but its identifiers
 *     are scrubbed (see buildSubjectRequestPlan).
 *   - IDEMPOTENCY / DUPLICATES: a second open request of the same kind for the
 *     same subject is rejected (isDuplicateSubjectRequest).
 *   - AUDIT: every assessment and execution is written to the immutable audit
 *     log as evidence.
 *
 * Self-heals its schema at runtime like the other governance stores.
 */
import { query, tableColumns } from "@/lib/db"
import { recordAuditLog, type AuditContext } from "@/lib/audit-log-store"
import { listPolicies } from "@/lib/retention-engine"
import { getPolicyHoldCoverage } from "@/lib/legal-hold-store"
import {
  SUBJECT_DATA_CATALOG,
  getSubjectLocation,
  isAnonymizable,
  resolveExistingColumn,
  resolveExistingColumns,
  type SubjectDataLocation,
} from "@/lib/privacy-subject-catalog"
import {
  buildSubjectRequestPlan,
  canRunRequest,
  isDuplicateSubjectRequest,
  normalizeSubjectRequestInput,
  requiresApproval,
  SUBJECT_REQUEST_KIND_LABELS,
  type SubjectLocationAssessment,
  type SubjectRequestKind,
  type SubjectRequestPlan,
  type SubjectRequestStatus,
} from "@/lib/privacy-model"

export type Actor = { userId: number; name?: string | null; email?: string | null; role?: string | null }

export type SubjectRequest = {
  id: number
  tenantId: number
  kind: SubjectRequestKind
  kindLabel: string
  subjectEmail: string
  subjectName: string | null
  status: SubjectRequestStatus
  reason: string | null
  requestedByUserId: number | null
  requestedByName: string | null
  decidedByName: string | null
  decidedAt: string | null
  resultSummary: string | null
  createdAt: string
  updatedAt: string
}

let schemaReady: Promise<void> | null = null

export function ensureSubjectRequestSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(
        `CREATE TABLE IF NOT EXISTS \`privacy_subject_requests\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`tenant_id\` INT NOT NULL,
          \`kind\` VARCHAR(16) NOT NULL,
          \`subject_email\` VARCHAR(190) NOT NULL,
          \`subject_name\` VARCHAR(160) NULL,
          \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending',
          \`reason\` VARCHAR(1000) NULL,
          \`requested_by_user_id\` INT NULL,
          \`requested_by_name\` VARCHAR(160) NULL,
          \`decided_by_name\` VARCHAR(160) NULL,
          \`decided_at\` DATETIME NULL,
          \`result_summary\` TEXT NULL,
          \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          KEY \`idx_psr_tenant_status\` (\`tenant_id\`, \`status\`),
          KEY \`idx_psr_tenant_subject\` (\`tenant_id\`, \`subject_email\`, \`kind\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      )
    })().catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

function mapRow(r: any): SubjectRequest {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    kind: r.kind,
    kindLabel: SUBJECT_REQUEST_KIND_LABELS[r.kind as SubjectRequestKind] ?? r.kind,
    subjectEmail: r.subject_email,
    subjectName: r.subject_name,
    status: r.status,
    reason: r.reason,
    requestedByUserId: r.requested_by_user_id == null ? null : Number(r.requested_by_user_id),
    requestedByName: r.requested_by_name,
    decidedByName: r.decided_by_name,
    decidedAt: r.decided_at,
    resultSummary: r.result_summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listSubjectRequests(tenantId: number, limit = 100): Promise<SubjectRequest[]> {
  await ensureSubjectRequestSchema()
  const capped = Math.min(500, Math.max(1, Math.floor(limit)))
  const rows = (await query(
    `SELECT * FROM \`privacy_subject_requests\` WHERE \`tenant_id\` = ? ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ?`,
    [tenantId, capped],
  )) as any[]
  return rows.map(mapRow)
}

export async function getSubjectRequest(tenantId: number, id: number): Promise<SubjectRequest | null> {
  await ensureSubjectRequestSchema()
  const rows = (await query(`SELECT * FROM \`privacy_subject_requests\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])) as any[]
  return rows[0] ? mapRow(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Live personal-data discovery
// ---------------------------------------------------------------------------

/**
 * Resolve one catalog location against the LIVE schema for this tenant: which
 * identifier columns and tenant column exist, and how many rows match the
 * subject. Returns null when the table/columns are absent on this install.
 */
async function resolveLocation(
  tenantId: number,
  entry: SubjectDataLocation,
  subjectEmail: string,
): Promise<{ tenantColumn: string; emailColumns: string[]; matches: number } | null> {
  const cols = await tableColumns(entry.table)
  if (cols.size === 0) return null
  const existing = new Set([...cols].map((c) => c.toLowerCase()))
  const tenantColumn = resolveExistingColumn(entry.tenantColumns, existing)
  const emailColumns = resolveExistingColumns(entry.emailColumns, existing)
  if (!tenantColumn || emailColumns.length === 0) return null
  const emailPredicate = emailColumns.map((c) => `LOWER(\`${c}\`) = ?`).join(" OR ")
  const rows = (await query(
    `SELECT COUNT(*) AS n FROM \`${entry.table}\` WHERE \`${tenantColumn}\` = ? AND (${emailPredicate})`,
    [tenantId, ...emailColumns.map(() => subjectEmail)],
  )) as any[]
  return { tenantColumn, emailColumns, matches: Number(rows[0]?.n ?? 0) }
}

/** True if an ACTIVE (non-paused/held) retention policy governs this catalog key. */
function hasActiveRetention(policies: { catalogKey: string | null; status: string }[], retentionKey: string | null): boolean {
  if (!retentionKey) return false
  return policies.some((p) => p.catalogKey === retentionKey && p.status === "active")
}

/**
 * Assess every personal-data location for a subject: match counts, retention
 * obligations and legal-hold coverage. This is the evidence the UI shows before
 * a destructive request and the input to buildSubjectRequestPlan.
 */
export async function assessSubject(
  tenantId: number,
  subjectEmail: string,
): Promise<SubjectLocationAssessment[]> {
  const policies = await listPolicies(tenantId).catch(() => [])
  const assessments: SubjectLocationAssessment[] = []
  for (const entry of SUBJECT_DATA_CATALOG) {
    const resolved = await resolveLocation(tenantId, entry, subjectEmail)
    if (!resolved) continue
    // Consult the SAME legal-hold coverage the retention sweep uses.
    const coverage = await getPolicyHoldCoverage(tenantId, {
      module: entry.module,
      catalogKey: entry.retentionKey,
      recordType: entry.label,
    }).catch(() => ({ fullyHeld: false, holdNames: [], recordRefs: [], criteria: [] }))
    const retained = !entry.erasable || hasActiveRetention(policies as any, entry.retentionKey)
    assessments.push({
      key: entry.key,
      label: entry.label,
      matches: resolved.matches,
      retained,
      held: coverage.fullyHeld,
      anonymizable: isAnonymizable(entry),
    })
  }
  return assessments
}

/** Assess a subject and fold the result into the execution plan for a kind. */
export async function planSubjectRequest(
  tenantId: number,
  kind: SubjectRequestKind,
  subjectEmail: string,
): Promise<{ assessments: SubjectLocationAssessment[]; plan: SubjectRequestPlan }> {
  const assessments = await assessSubject(tenantId, subjectEmail)
  return { assessments, plan: buildSubjectRequestPlan(kind, assessments) }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a DSAR. Rejects a duplicate OPEN request for the same kind + subject
 * (idempotency). Destructive kinds start `pending` (awaiting approval); export
 * also starts `pending` but may be run immediately.
 */
export async function createSubjectRequest(
  tenantId: number,
  input: unknown,
  actor: Actor,
  auditContext?: AuditContext,
): Promise<SubjectRequest> {
  await ensureSubjectRequestSchema()
  const data = normalizeSubjectRequestInput((input ?? {}) as Record<string, unknown>)

  const open = (await query(
    `SELECT \`kind\`, \`subject_email\`, \`status\` FROM \`privacy_subject_requests\`
      WHERE \`tenant_id\` = ? AND \`subject_email\` = ? AND \`kind\` = ? AND \`status\` IN ('pending','approved')`,
    [tenantId, data.subjectEmail, data.kind],
  )) as any[]
  if (
    isDuplicateSubjectRequest(
      { kind: data.kind, subjectEmail: data.subjectEmail },
      open.map((r) => ({ kind: r.kind, subjectEmail: r.subject_email, status: r.status })),
    )
  ) {
    throw new Error("An open request of this type already exists for this subject")
  }

  const result = (await query(
    `INSERT INTO \`privacy_subject_requests\`
       (\`tenant_id\`, \`kind\`, \`subject_email\`, \`subject_name\`, \`status\`, \`reason\`, \`requested_by_user_id\`, \`requested_by_name\`)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [tenantId, data.kind, data.subjectEmail, data.subjectName, data.reason, actor.userId, actor.name ?? null],
  )) as any
  const id = Number(result.insertId)
  await recordAuditLog(
    {
      action: "privacy.subject_request.created",
      entityType: "SubjectRequest",
      entityId: id,
      entityLabel: `${SUBJECT_REQUEST_KIND_LABELS[data.kind]} — ${data.subjectEmail}`,
      after: { kind: data.kind, subjectEmail: data.subjectEmail },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  const row = await getSubjectRequest(tenantId, id)
  return row!
}

// ---------------------------------------------------------------------------
// Approve / reject
// ---------------------------------------------------------------------------

export async function decideSubjectRequest(
  tenantId: number,
  id: number,
  decision: "approve" | "reject",
  actor: Actor,
  auditContext?: AuditContext,
): Promise<SubjectRequest> {
  await ensureSubjectRequestSchema()
  const req = await getSubjectRequest(tenantId, id)
  if (!req) throw new Error("Request not found")
  if (req.status !== "pending") throw new Error(`Only a pending request can be ${decision}d`)
  if (decision === "approve" && !requiresApproval(req.kind)) {
    throw new Error("This request type does not require approval; run it directly")
  }
  const nextStatus: SubjectRequestStatus = decision === "approve" ? "approved" : "rejected"
  await query(
    `UPDATE \`privacy_subject_requests\` SET \`status\` = ?, \`decided_by_name\` = ?, \`decided_at\` = NOW() WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [nextStatus, actor.name ?? null, id, tenantId],
  )
  await recordAuditLog(
    {
      action: `privacy.subject_request.${decision === "approve" ? "approved" : "rejected"}`,
      entityType: "SubjectRequest",
      entityId: id,
      entityLabel: `${req.kindLabel} — ${req.subjectEmail}`,
      before: { status: req.status },
      after: { status: nextStatus },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  return (await getSubjectRequest(tenantId, id))!
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export type SubjectExecutionResult = {
  request: SubjectRequest
  plan: SubjectRequestPlan
  /** For export: the subject's data keyed by location. */
  exportData?: Record<string, Record<string, unknown>[]>
  erased: number
  anonymized: number
}

/**
 * Overwrite the resolved PII columns of a location's matching rows with a
 * stable redaction token. Returns the number of rows affected.
 */
async function anonymizeLocation(tenantId: number, entry: SubjectDataLocation, subjectEmail: string): Promise<number> {
  const cols = await tableColumns(entry.table)
  if (cols.size === 0) return 0
  const existing = new Set([...cols].map((c) => c.toLowerCase()))
  const tenantColumn = resolveExistingColumn(entry.tenantColumns, existing)
  const emailColumns = resolveExistingColumns(entry.emailColumns, existing)
  const piiColumns = entry.piiColumns.filter((c) => existing.has(c.toLowerCase()))
  if (!tenantColumn || emailColumns.length === 0 || piiColumns.length === 0) return 0
  const emailPredicate = emailColumns.map((c) => `LOWER(\`${c}\`) = ?`).join(" OR ")
  // Redact identifier columns too so the row can no longer be linked to the person.
  const redactColumns = Array.from(new Set([...piiColumns, ...emailColumns]))
  const setClause = redactColumns.map((c) => `\`${c}\` = ?`).join(", ")
  const result = (await query(
    `UPDATE \`${entry.table}\` SET ${setClause} WHERE \`${tenantColumn}\` = ? AND (${emailPredicate})`,
    [...redactColumns.map(() => "[redacted]"), tenantId, ...emailColumns.map(() => subjectEmail)],
  )) as any
  return Number(result.affectedRows ?? 0)
}

async function eraseLocation(tenantId: number, entry: SubjectDataLocation, subjectEmail: string): Promise<number> {
  const cols = await tableColumns(entry.table)
  if (cols.size === 0) return 0
  const existing = new Set([...cols].map((c) => c.toLowerCase()))
  const tenantColumn = resolveExistingColumn(entry.tenantColumns, existing)
  const emailColumns = resolveExistingColumns(entry.emailColumns, existing)
  if (!tenantColumn || emailColumns.length === 0) return 0
  const emailPredicate = emailColumns.map((c) => `LOWER(\`${c}\`) = ?`).join(" OR ")
  const result = (await query(
    `DELETE FROM \`${entry.table}\` WHERE \`${tenantColumn}\` = ? AND (${emailPredicate})`,
    [tenantId, ...emailColumns.map(() => subjectEmail)],
  )) as any
  return Number(result.affectedRows ?? 0)
}

async function collectLocation(tenantId: number, entry: SubjectDataLocation, subjectEmail: string): Promise<Record<string, unknown>[]> {
  const cols = await tableColumns(entry.table)
  if (cols.size === 0) return []
  const existing = new Set([...cols].map((c) => c.toLowerCase()))
  const tenantColumn = resolveExistingColumn(entry.tenantColumns, existing)
  const emailColumns = resolveExistingColumns(entry.emailColumns, existing)
  if (!tenantColumn || emailColumns.length === 0) return []
  const emailPredicate = emailColumns.map((c) => `LOWER(\`${c}\`) = ?`).join(" OR ")
  const rows = (await query(
    `SELECT * FROM \`${entry.table}\` WHERE \`${tenantColumn}\` = ? AND (${emailPredicate})`,
    [tenantId, ...emailColumns.map(() => subjectEmail)],
  )) as any[]
  return rows
}

/**
 * Execute a DSAR. Idempotent over terminal states: a completed request is not
 * re-run. Enforces the run-gate (canRunRequest) so a destructive request is
 * only executed after approval. A legal-hold conflict never blocks the whole
 * run — held locations are simply left untouched and reported.
 */
export async function runSubjectRequest(
  tenantId: number,
  id: number,
  actor: Actor,
  auditContext?: AuditContext,
): Promise<SubjectExecutionResult> {
  await ensureSubjectRequestSchema()
  const req = await getSubjectRequest(tenantId, id)
  if (!req) throw new Error("Request not found")
  if (!canRunRequest(req.kind, req.status)) {
    throw new Error(
      requiresApproval(req.kind)
        ? "This request must be approved before it can run"
        : `A ${req.status} request cannot be run`,
    )
  }

  const { assessments, plan } = await planSubjectRequest(tenantId, req.kind, req.subjectEmail)

  // ----- Export -----------------------------------------------------------
  if (req.kind === "export") {
    const exportData: Record<string, Record<string, unknown>[]> = {}
    for (const entry of SUBJECT_DATA_CATALOG) {
      const rows = await collectLocation(tenantId, entry, req.subjectEmail)
      if (rows.length > 0) exportData[entry.key] = rows
    }
    const summary = `Exported ${Object.values(exportData).reduce((n, r) => n + r.length, 0)} record(s) across ${Object.keys(exportData).length} location(s)`
    await finalize(tenantId, id, "completed", summary)
    await recordAuditLog(
      {
        action: "privacy.subject_request.exported",
        entityType: "SubjectRequest",
        entityId: id,
        entityLabel: `${req.kindLabel} — ${req.subjectEmail}`,
        after: { locations: Object.keys(exportData), summary },
        context: auditContext ? { ...auditContext, tenantId } : { tenantId },
      },
      auditContext,
    )
    return { request: (await getSubjectRequest(tenantId, id))!, plan, exportData, erased: 0, anonymized: 0 }
  }

  // ----- Erase / anonymize ------------------------------------------------
  let erased = 0
  let anonymized = 0
  for (const loc of plan.eraseLocations) {
    const entry = getSubjectLocation(loc.key)
    if (entry) erased += await eraseLocation(tenantId, entry, req.subjectEmail)
  }
  for (const loc of plan.anonymizeLocations) {
    const entry = getSubjectLocation(loc.key)
    if (entry) anonymized += await anonymizeLocation(tenantId, entry, req.subjectEmail)
  }

  const parts: string[] = []
  if (erased) parts.push(`${erased} record(s) erased`)
  if (anonymized) parts.push(`${anonymized} record(s) anonymized (retention conflict)`)
  if (plan.blockedLocations.length) parts.push(`${plan.blockedLocations.length} location(s) blocked by legal hold`)
  const summary = parts.join("; ") || "No matching personal data found"

  await finalize(tenantId, id, "completed", summary)
  await recordAuditLog(
    {
      action: "privacy.subject_request.executed",
      entityType: "SubjectRequest",
      entityId: id,
      entityLabel: `${req.kindLabel} — ${req.subjectEmail}`,
      after: {
        erased,
        anonymized,
        blockedByLegalHold: plan.blockedLocations.map((l) => l.label),
        retentionDowngrades: plan.anonymizeLocations.map((l) => l.label),
        summary,
      },
      context: auditContext ? { ...auditContext, tenantId } : { tenantId },
    },
    auditContext,
  )
  return { request: (await getSubjectRequest(tenantId, id))!, plan, erased, anonymized }
}

async function finalize(tenantId: number, id: number, status: SubjectRequestStatus, summary: string): Promise<void> {
  await query(
    `UPDATE \`privacy_subject_requests\` SET \`status\` = ?, \`result_summary\` = ? WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [status, summary.slice(0, 2000), id, tenantId],
  )
}
