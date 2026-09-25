import "server-only"
import { query } from "@/lib/db"
import { currentTenantId, currentTenantIdOrNull, scopedWhere, tenantInsert, tenantUpdate } from "@/lib/tenant-scope"
import { downloadFile } from "./index"
import { getFileById, getByObjectKey, type FileObject } from "./file-metadata"
import { resolveScanProviderFromEnv, runWithScanTimeout, ScanTimeoutError } from "./scan-providers"

/**
 * Malware / file-security scanning.
 * ---------------------------------------------------------------------------
 * Every file the ERP stores ( records one normalized row per object) is
 * put through a security scan before it can be handed back to a user. This
 * module owns that lifecycle end-to-end and is deliberately split into three
 * decoupled layers:
 *
 *   1. A pure VOCABULARY + POLICY layer (scan status, safety verdict,
 *      quarantine state, and the download gate) with no I/O — unit-tested
 *      without a database.
 *   2. A REPLACEABLE PROVIDER layer: `FileScanProvider` is the one contract a
 *      scanning backend implements. A deterministic built-in heuristic scanner
 *      ships as the default; swapping in ClamAV, a cloud AV API, etc. is a
 *      single `setFileScanProvider(...)` call and touches nothing else.
 *   3. An ASYNCHRONOUS orchestration layer backed by `file_security_scans`:
 *      an upload enqueues a scan (fire-and-forget) that transitions the row
 *      pending → scanning → clean/infected/error, releasing or holding the
 *      file in quarantine per policy.
 *
 * Everything is tenant-scoped through the helpers, so one tenant can
 * never see, approve, rescan, or unblock another tenant's files.
 */

const TABLE = "file_security_scans"

/**
 * Max wall-clock a single scan may take before it is treated as an ERROR
 * verdict (which a gated file's fail-closed policy withholds). Configurable via
 * `STORAGE_SCAN_TIMEOUT_MS`; defaults to 30s.
 */
const SCAN_TIMEOUT_MS =
  Number(process.env.STORAGE_SCAN_TIMEOUT_MS) > 0 ? Number(process.env.STORAGE_SCAN_TIMEOUT_MS) : 30_000

// ---------------------------------------------------------------------------
// Pure vocabulary + policy (unit-tested without a DB)
// ---------------------------------------------------------------------------

/** Where a scan is in its lifecycle. */
export type ScanStatus = "pending" | "scanning" | "clean" | "infected" | "error"

/** The user-facing safety verdict derived from the scan status. */
export type SafetyStatus = "safe" | "unsafe" | "unknown"

/** Whether the object is withheld from download. */
export type QuarantineStatus = "quarantined" | "released" | "not_required"

/** A single scanner verdict (what the provider concluded). */
export type ScanVerdict = "clean" | "infected" | "error"

const SCAN_STATUSES: readonly ScanStatus[] = ["pending", "scanning", "clean", "infected", "error"]

export function normalizeScanStatus(value: string | null | undefined): ScanStatus {
  return SCAN_STATUSES.includes(value as ScanStatus) ? (value as ScanStatus) : "pending"
}

/** Map the lifecycle status to a simple safe / unsafe / unknown verdict. */
export function safetyFromStatus(status: ScanStatus): SafetyStatus {
  if (status === "clean") return "safe"
  if (status === "infected") return "unsafe"
  return "unknown"
}

/** An infected file can never be approved back into circulation. */
export function isApprovable(status: ScanStatus): boolean {
  return status !== "infected"
}

/** How aggressively downloads are gated for a given file. */
export type ScanFailureMode = "fail_closed" | "fail_open"

export type DownloadGatePolicy = {
  /** Block downloads until the file is proven clean (or admin-approved). */
  blockUntilClean: boolean
  /** On a scan ERROR (scanner unavailable/failed): hold (fail_closed) or allow (fail_open). */
  failureMode: ScanFailureMode
}

/**
 * Resolve the download gate for a file. Public assets are never gated; anything
 * internal/confidential/restricted is blocked until clean and fails closed, so
 * an unscannable or infected file is withheld rather than leaked.
 */
export function downloadGatePolicyFor(file: Pick<FileObject, "classification">): DownloadGatePolicy {
  if (file.classification === "public") return { blockUntilClean: false, failureMode: "fail_open" }
  return { blockUntilClean: true, failureMode: "fail_closed" }
}

export type DownloadDecision = { allowed: boolean; reason: string }

/**
 * The core gate: given a file's current security state and its policy, decide
 * whether the bytes may be released. Pure and total — every lifecycle state has
 * a defined outcome, which is what the malicious/failed/unknown tests pin down.
 */
export function canDownload(
  state: { scanStatus: ScanStatus; approved: boolean },
  policy: DownloadGatePolicy,
): DownloadDecision {
  // Infected is terminal and never downloadable — not even with approval.
  if (state.scanStatus === "infected") {
    return { allowed: false, reason: "File is infected and permanently blocked" }
  }
  // Proven clean is always allowed.
  if (state.scanStatus === "clean") {
    return { allowed: true, reason: "Clean" }
  }
  // Remaining states: pending | scanning | error.
  // An administrator can explicitly release these uncertain states.
  if (state.approved) {
    return { allowed: true, reason: "Released by administrator" }
  }
  // Policy may not gate downloads at all (e.g. public assets).
  if (!policy.blockUntilClean) {
    return { allowed: true, reason: "Downloads are not gated for this file" }
  }
  if (state.scanStatus === "error") {
    if (policy.failureMode === "fail_open") {
      return { allowed: true, reason: "Scan unavailable; allowed by fail-open policy" }
    }
    return { allowed: false, reason: "Scan failed; awaiting administrator approval" }
  }
  // pending | scanning
  return { allowed: false, reason: "Awaiting security scan" }
}

/** Thrown by the download path when a file is withheld by the security gate. */
export class FileDownloadBlockedError extends Error {
  readonly blocked = true
  readonly status = 403
  constructor(reason: string) {
    super(reason)
    this.name = "FileDownloadBlockedError"
  }
}

// ---------------------------------------------------------------------------
// Replaceable scanning provider
// ---------------------------------------------------------------------------

export type ScanFindingSeverity = "low" | "medium" | "high" | "critical"

export type ScanFinding = {
  /** The signature/rule that matched (e.g. "EICAR-STANDARD-ANTIVIRUS-TEST-FILE"). */
  signature: string
  severity: ScanFindingSeverity
}

/** What the orchestrator hands a provider. `read()` lazily streams the bytes. */
export type ScanRequest = {
  fileId: number
  objectKey: string
  filename: string | null
  mimeType: string | null
  size: number
  read: () => Promise<Buffer>
}

export type ScanOutcome = {
  verdict: ScanVerdict
  provider: string
  findings?: ScanFinding[]
  detail?: string | null
}

/**
 * The one contract a scanning backend implements. Callers depend only on this,
 * never on a specific engine, so the provider is fully replaceable.
 */
export interface FileScanProvider {
  readonly id: string
  scan(request: ScanRequest): Promise<ScanOutcome>
}

/** Signatures the built-in heuristic scanner looks for. */
const HEURISTIC_SIGNATURES: readonly { name: string; marker: string; severity: ScanFindingSeverity }[] = [
  // Industry-standard, harmless AV test string.
  { name: "EICAR-STANDARD-ANTIVIRUS-TEST-FILE", marker: "EICAR-STANDARD-ANTIVIRUS-TEST-FILE", severity: "critical" },
  // A marker the app/tests can embed to exercise the infected path deterministically.
  { name: "V0-Malware-Test-Marker", marker: "V0-MALWARE-TEST", severity: "high" },
]

const HUMAN_MB = (n: number) => `${Math.round(n / (1024 * 1024))} MB`

/**
 * Deterministic, dependency-free default scanner. It matches known-bad
 * signatures in the object bytes and reports oversize objects as a scan ERROR
 * (fail-closed) so they are routed to a real external scanner rather than
 * silently passed. This is the drop-in default; production swaps in a real AV
 * engine via `setFileScanProvider`.
 */
export class HeuristicScanProvider implements FileScanProvider {
  readonly id = "builtin-heuristic"
  readonly maxInlineBytes = 50 * 1024 * 1024

  async scan(request: ScanRequest): Promise<ScanOutcome> {
    if (request.size > this.maxInlineBytes) {
      return {
        verdict: "error",
        provider: this.id,
        detail: `File exceeds the ${HUMAN_MB(this.maxInlineBytes)} inline scan limit; route to an external scanner.`,
      }
    }
    let buffer: Buffer
    try {
      buffer = await request.read()
    } catch {
      return { verdict: "error", provider: this.id, detail: "Could not read the stored object for scanning" }
    }
    const findings = detectSignatures(buffer)
    if (findings.length > 0) {
      return {
        verdict: "infected",
        provider: this.id,
        findings,
        detail: findings.map((f) => f.signature).join(", "),
      }
    }
    return { verdict: "clean", provider: this.id }
  }
}

/** Scan a buffer for known-bad markers. Exported for unit tests. */
export function detectSignatures(buffer: Buffer): ScanFinding[] {
  const text = buffer.toString("latin1")
  const out: ScanFinding[] = []
  for (const sig of HEURISTIC_SIGNATURES) {
    if (text.includes(sig.marker)) out.push({ signature: sig.name, severity: sig.severity })
  }
  return out
}

let activeProvider: FileScanProvider = new HeuristicScanProvider()
let providerExplicitlySet = false
let envProviderResolved = false

/** Swap the active scanning backend. This is the entire "replaceable provider" surface. */
export function setFileScanProvider(provider: FileScanProvider): void {
  activeProvider = provider
  providerExplicitlySet = true
}

/**
 * The scanning backend currently in effect. When nothing has been set
 * explicitly, a real backend (e.g. ClamAV) is resolved from the environment
 * ONCE, falling back to the deterministic built-in heuristic. This is what lets
 * production run a real AV engine with only configuration — no code change.
 */
export function getFileScanProvider(): FileScanProvider {
  if (!providerExplicitlySet && !envProviderResolved) {
    envProviderResolved = true
    try {
      const fromEnv = resolveScanProviderFromEnv()
      if (fromEnv) activeProvider = fromEnv
    } catch (err) {
      console.error("[v0] scan provider env resolution failed; using built-in heuristic:", err)
    }
  }
  return activeProvider
}

/**
 * Best-effort file-security access audit. Records scan verdicts and admin
 * releases into the enterprise audit log so every file carries a forensic
 * access trail. Dynamically imported to keep this module's pure/DB-free unit
 * surface (and its import graph) untouched; never throws to the caller.
 */
async function auditFileSecurity(
  action: string,
  entry: {
    fileId: number
    fileRef?: string | null
    result?: "success" | "failure" | "denied"
    actorId?: number | null
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  try {
    const { recordAuditLog } = await import("@/lib/audit-log-store")
    await recordAuditLog({
      action,
      result: entry.result ?? "success",
      entityType: "file",
      entityId: entry.fileId,
      entityLabel: entry.fileRef ?? null,
      metadata: entry.metadata ?? null,
      context: { tenantId: currentTenantIdOrNull(), actorUserId: entry.actorId ?? null },
    })
  } catch (err) {
    console.error("[v0] file security audit write failed (ignored):", err)
  }
}

// ---------------------------------------------------------------------------
// Schema + persistence
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

export function ensureFileSecuritySchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function doEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      file_id BIGINT NOT NULL,
      file_ref VARCHAR(40) DEFAULT NULL,
      object_key VARCHAR(1024) NOT NULL,
      scan_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      safety VARCHAR(12) NOT NULL DEFAULT 'unknown',
      quarantine_status VARCHAR(16) NOT NULL DEFAULT 'quarantined',
      provider VARCHAR(60) DEFAULT NULL,
      findings TEXT DEFAULT NULL,
      detail VARCHAR(500) DEFAULT NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      approved TINYINT(1) NOT NULL DEFAULT 0,
      approved_by INT DEFAULT NULL,
      approved_at DATETIME DEFAULT NULL,
      requested_by INT DEFAULT NULL,
      scanned_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_fss_tenant_file (tenant_id, file_id),
      KEY idx_fss_tenant (tenant_id),
      KEY idx_fss_status (tenant_id, scan_status),
      KEY idx_fss_quarantine (tenant_id, quarantine_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

type ScanRow = {
  id: number
  file_id: number
  file_ref: string | null
  object_key: string
  scan_status: ScanStatus
  safety: SafetyStatus
  quarantine_status: QuarantineStatus
  provider: string | null
  findings: string | null
  detail: string | null
  attempts: number
  approved: 0 | 1
  approved_by: number | null
  approved_at: string | null
  requested_by: number | null
  scanned_at: string | null
  created_at: string | null
  updated_at: string | null
}

export type ScanRecord = {
  id: number
  fileId: number
  fileRef: string | null
  objectKey: string
  scanStatus: ScanStatus
  safety: SafetyStatus
  quarantineStatus: QuarantineStatus
  provider: string | null
  findings: ScanFinding[]
  detail: string | null
  attempts: number
  approved: boolean
  approvedBy: number | null
  approvedAt: string | null
  requestedBy: number | null
  scannedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

function parseFindings(raw: string | null): ScanFinding[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ScanFinding[]) : []
  } catch {
    return []
  }
}

function toScanRecord(row: ScanRow): ScanRecord {
  return {
    id: Number(row.id),
    fileId: Number(row.file_id),
    fileRef: row.file_ref,
    objectKey: row.object_key,
    scanStatus: normalizeScanStatus(row.scan_status),
    safety: safetyFromStatus(normalizeScanStatus(row.scan_status)),
    quarantineStatus: (["quarantined", "released", "not_required"] as const).includes(row.quarantine_status)
      ? row.quarantine_status
      : "quarantined",
    provider: row.provider,
    findings: parseFindings(row.findings),
    detail: row.detail,
    attempts: Number(row.attempts),
    approved: Number(row.approved) === 1,
    approvedBy: row.approved_by == null ? null : Number(row.approved_by),
    approvedAt: row.approved_at,
    requestedBy: row.requested_by == null ? null : Number(row.requested_by),
    scannedAt: row.scanned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function getScanRow(fileId: number): Promise<ScanRow | null> {
  await ensureFileSecuritySchema()
  const { where, params } = scopedWhere(TABLE, "file_id = ?", [fileId])
  const rows = await query<ScanRow[]>(`SELECT * FROM ${TABLE} ${where} LIMIT 1`, params)
  return rows[0] ?? null
}

/** Current security state for a file, or null when none has been recorded. */
export async function getScanForFile(fileId: number): Promise<ScanRecord | null> {
  const row = await getScanRow(fileId)
  return row ? toScanRecord(row) : null
}

// ---------------------------------------------------------------------------
// Orchestration (asynchronous scanning)
// ---------------------------------------------------------------------------

/**
 * Create (or reset) a file's scan row to `pending`, quarantining it per policy.
 * Called at upload time and by an explicit rescan; safe to call repeatedly.
 */
export async function recordPendingScan(file: FileObject, requestedBy: number | null = null): Promise<ScanRecord> {
  await ensureFileSecuritySchema()
  const policy = downloadGatePolicyFor(file)
  const quarantine: QuarantineStatus = policy.blockUntilClean ? "quarantined" : "not_required"
  const existing = await getScanRow(file.id)
  if (existing) {
    await tenantUpdate(
      TABLE,
      {
        file_ref: file.fileRef,
        object_key: file.objectKey,
        scan_status: "pending",
        safety: "unknown",
        quarantine_status: quarantine,
        provider: null,
        findings: null,
        detail: null,
        approved: 0,
        approved_by: null,
        approved_at: null,
        requested_by: requestedBy ?? existing.requested_by ?? null,
        scanned_at: null,
      },
      "id = ?",
      [existing.id],
    )
    return (await getScanForFile(file.id))!
  }
  await tenantInsert(TABLE, {
    file_id: file.id,
    file_ref: file.fileRef,
    object_key: file.objectKey,
    scan_status: "pending",
    safety: "unknown",
    quarantine_status: quarantine,
    attempts: 0,
    approved: 0,
    requested_by: requestedBy,
  })
  return (await getScanForFile(file.id))!
}

/** Persist a provider outcome, transitioning status/safety/quarantine. */
async function applyOutcome(file: FileObject, outcome: ScanOutcome): Promise<ScanRecord> {
  const status: ScanStatus =
    outcome.verdict === "clean" ? "clean" : outcome.verdict === "infected" ? "infected" : "error"
  const policy = downloadGatePolicyFor(file)
  const existing = await getScanRow(file.id)

  let quarantine: QuarantineStatus =
    (existing?.quarantine_status as QuarantineStatus) ?? (policy.blockUntilClean ? "quarantined" : "not_required")
  if (status === "clean") quarantine = policy.blockUntilClean ? "released" : "not_required"
  else if (status === "infected") quarantine = "quarantined"
  // On error we intentionally leave the file where it is (quarantined when gated),
  // so a fail-closed policy keeps withholding it until an admin approves or a rescan clears it.

  await tenantUpdate(
    TABLE,
    {
      scan_status: status,
      safety: safetyFromStatus(status),
      quarantine_status: quarantine,
      provider: outcome.provider,
      findings: outcome.findings && outcome.findings.length ? JSON.stringify(outcome.findings) : null,
      detail: outcome.detail ? String(outcome.detail).slice(0, 500) : null,
      attempts: (existing ? Number(existing.attempts) : 0) + 1,
      scanned_at: new Date(),
    },
    "file_id = ?",
    [file.id],
  )
  // Access audit: record the verdict against the file so every scanned object
  // carries a forensic security trail (infected = a denied access event).
  const auditAction =
    status === "clean" ? "file.scan_clean" : status === "infected" ? "file.scan_infected" : "file.scan_error"
  await auditFileSecurity(auditAction, {
    fileId: file.id,
    fileRef: file.fileRef,
    result: status === "infected" ? "denied" : status === "error" ? "failure" : "success",
    metadata: {
      provider: outcome.provider,
      verdict: outcome.verdict,
      detail: outcome.detail ?? null,
      findings: outcome.findings ?? [],
    },
  })
  return (await getScanForFile(file.id))!
}

async function readToBuffer(body: ReadableStream<Uint8Array> | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body
  const chunks: Uint8Array[] = []
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

/**
 * Run the active provider against one file and persist the result. Marks the
 * row `scanning` first, and converts any provider throw into a scan `error`
 * (never propagates) so scan failures are recorded, not lost.
 */
export async function runScan(fileId: number): Promise<ScanRecord | null> {
  const file = await getFileById(fileId)
  if (!file) return null
  // Ensure a row exists and flip it to scanning.
  if (!(await getScanRow(fileId))) await recordPendingScan(file, null)
  await tenantUpdate(TABLE, { scan_status: "scanning" }, "file_id = ?", [fileId])

  const provider = getFileScanProvider()
  let outcome: ScanOutcome
  try {
    outcome = await runWithScanTimeout(
      provider.scan({
        fileId: file.id,
        objectKey: file.objectKey,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        read: async () => {
          const src = await downloadFile(file.objectKey)
          return readToBuffer(src.body)
        },
      }),
      SCAN_TIMEOUT_MS,
    )
  } catch (err) {
    if (err instanceof ScanTimeoutError) {
      console.error("[v0] scan timed out:", err.message)
      // A hung/unreachable scanner is an ERROR verdict, which a gated file's
      // fail-closed policy withholds until an admin approves or a rescan clears it.
      outcome = { verdict: "error", provider: provider.id, detail: "Scanner timed out; file held (fail-closed)" }
    } else {
      console.error("[v0] scan provider threw:", err)
      outcome = { verdict: "error", provider: provider.id, detail: "The scanner raised an unexpected error" }
    }
  }
  return applyOutcome(file, outcome)
}

/**
 * Enqueue an asynchronous scan for a freshly uploaded file. Fire-and-forget:
 * it records the pending row and kicks off the scan without blocking (or ever
 * failing) the upload path.
 */
export function enqueueScan(file: FileObject, opts: { requestedBy?: number | null } = {}): void {
  void (async () => {
    try {
      await recordPendingScan(file, opts.requestedBy ?? null)
      await runScan(file.id)
    } catch (err) {
      console.error("[v0] enqueueScan failed:", err)
    }
  })()
}

/** Synchronously (awaitably) scan a file now — used by the explicit rescan action. */
export async function scanFileNow(fileId: number, requestedBy: number | null = null): Promise<ScanRecord | null> {
  const file = await getFileById(fileId)
  if (!file) return null
  await recordPendingScan(file, requestedBy)
  return runScan(fileId)
}

export type ApproveActor = { userId: number; role: "admin" | "employee" }

/**
 * Administrator release of a quarantined file whose scan is uncertain
 * (pending/scanning/error). Infected files are never approvable.
 */
export async function approveFile(
  fileId: number,
  actor: ApproveActor,
): Promise<{ ok: true; record: ScanRecord } | { ok: false; error: string; status: number }> {
  if (actor.role !== "admin") {
    return { ok: false, error: "Only an administrator can approve a quarantined file", status: 403 }
  }
  const record = await getScanForFile(fileId)
  if (!record) return { ok: false, error: "No scan record for this file", status: 404 }
  if (!isApprovable(record.scanStatus)) {
    return { ok: false, error: "An infected file cannot be approved for download", status: 409 }
  }
  await tenantUpdate(
    TABLE,
    { approved: 1, approved_by: actor.userId, approved_at: new Date(), quarantine_status: "released" },
    "file_id = ?",
    [fileId],
  )
  await auditFileSecurity("file.scan_released", {
    fileId,
    fileRef: record.fileRef,
    actorId: actor.userId,
    metadata: { previousStatus: record.scanStatus, releasedBy: actor.userId },
  })
  return { ok: true, record: (await getScanForFile(fileId))! }
}

// ---------------------------------------------------------------------------
// Download gate (used by the signed-URL path)
// ---------------------------------------------------------------------------

/**
 * Enforce the security gate for a stored object key. No-op when the key is
 * untracked (legacy files predating scanning) or its policy allows the download;
 * throws `FileDownloadBlockedError` (HTTP 403) otherwise. Called before any
 * signed download URL is minted.
 */
export async function enforceDownloadPolicyForKey(objectKey: string): Promise<void> {
  const file = await getByObjectKey(objectKey).catch(() => null)
  if (!file) return
  const record = await getScanForFile(file.id).catch(() => null)
  if (!record) return
  const policy = downloadGatePolicyFor(file)
  const decision = canDownload({ scanStatus: record.scanStatus, approved: record.approved }, policy)
  if (!decision.allowed) throw new FileDownloadBlockedError(decision.reason)
}

// ---------------------------------------------------------------------------
// Listing (admin console)
// ---------------------------------------------------------------------------

export type ScanListItem = ScanRecord & {
  filename: string | null
  module: string | null
  version: number | null
}

/** Resolve filename/module/version for a set of file ids, scoped to the tenant. */
async function resolveFileInfo(
  fileIds: number[],
): Promise<Map<number, { filename: string | null; module: string | null; version: number | null }>> {
  const map = new Map<number, { filename: string | null; module: string | null; version: number | null }>()
  const ids = Array.from(new Set(fileIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)))
  if (ids.length === 0) return map
  const placeholders = ids.map(() => "?").join(", ")
  const rows = await query<{ id: number; filename: string | null; module: string | null; version: number }[]>(
    `SELECT id, filename, module, version FROM file_objects WHERE id IN (${placeholders}) AND tenant_id = ?`,
    [...ids, currentTenantId()],
  )
  for (const r of rows) map.set(Number(r.id), { filename: r.filename, module: r.module, version: Number(r.version) })
  return map
}

/** List the tenant's scan records (optionally only quarantined), newest first. */
export async function listScans(filter: { quarantinedOnly?: boolean; limit?: number } = {}): Promise<ScanListItem[]> {
  await ensureFileSecuritySchema()
  const extra = filter.quarantinedOnly ? "quarantine_status = 'quarantined'" : ""
  const { where, params } = scopedWhere(TABLE, extra)
  const limit = Math.max(1, Math.min(500, filter.limit ?? 200))
  const rows = await query<ScanRow[]>(`SELECT * FROM ${TABLE} ${where} ORDER BY id DESC LIMIT ?`, [...params, limit])
  const info = await resolveFileInfo(rows.map((r) => Number(r.file_id)))
  return rows.map((r) => {
    const rec = toScanRecord(r)
    const meta = info.get(rec.fileId)
    return { ...rec, filename: meta?.filename ?? null, module: meta?.module ?? null, version: meta?.version ?? null }
  })
}
