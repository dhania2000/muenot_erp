/**
 * SPEC 75 — Backup architecture (pure, testable model).
 * ---------------------------------------------------------------------------
 * A backup binds a SCOPE (a tenant's database, its stored-file manifest, or its
 * configuration) to a POLICY (schedule, retention, encryption, verification and
 * restore-test cadence) and produces a single verifiable, encrypted ARTIFACT.
 *
 * This module is the DB-free, Node-free core: scope/frequency/status
 * normalization, the deterministic scheduling / retention / expiry math, the
 * artifact envelope shape and its pure (de)serialization + validation helpers,
 * and byte formatting. It carries no `server-only`, `node:*`, or DB import so it
 * can be unit-tested directly and (type-only) shared with the UI. The crypto,
 * DB store, engine and request wiring live in lib/backup/store.ts.
 */

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export const BACKUP_SCOPES = ["database", "files", "config"] as const
export type BackupScope = (typeof BACKUP_SCOPES)[number]

export const BACKUP_SCOPE_LABELS: Record<BackupScope, string> = {
  database: "Database backup",
  files: "File / object storage backup",
  config: "Configuration backup",
}

export const BACKUP_SCOPE_DESCRIPTIONS: Record<BackupScope, string> = {
  database: "Tenant-scoped logical snapshot of every business table the tenant owns.",
  files: "Manifest of the tenant's stored file objects (checksums, sizes, storage keys).",
  config: "Tenant configuration, settings, templates and policy tables.",
}

export function isBackupScope(value: unknown): value is BackupScope {
  return typeof value === "string" && (BACKUP_SCOPES as readonly string[]).includes(value)
}

export function toBackupScope(value: unknown): BackupScope | null {
  return isBackupScope(value) ? value : null
}

// ---------------------------------------------------------------------------
// Frequency (backup schedule + restore-test cadence)
// ---------------------------------------------------------------------------

export const BACKUP_FREQUENCIES = ["daily", "weekly", "monthly"] as const
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number]

export function toBackupFrequency(value: unknown): BackupFrequency {
  return typeof value === "string" && (BACKUP_FREQUENCIES as readonly string[]).includes(value)
    ? (value as BackupFrequency)
    : "daily"
}

/** Restore-test cadence. "none" disables automatic restore testing. */
export const RESTORE_TEST_FREQUENCIES = ["none", "weekly", "monthly"] as const
export type RestoreTestFrequency = (typeof RESTORE_TEST_FREQUENCIES)[number]

export function toRestoreTestFrequency(value: unknown): RestoreTestFrequency {
  return typeof value === "string" && (RESTORE_TEST_FREQUENCIES as readonly string[]).includes(value)
    ? (value as RestoreTestFrequency)
    : "weekly"
}

// ---------------------------------------------------------------------------
// Run + verification + restore-test status
// ---------------------------------------------------------------------------

export const BACKUP_RUN_STATUSES = ["running", "completed", "failed", "expired"] as const
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number]

export const BACKUP_VERIFICATION_STATUSES = ["unverified", "passed", "failed"] as const
export type BackupVerificationStatus = (typeof BACKUP_VERIFICATION_STATUSES)[number]

export const RESTORE_TEST_STATUSES = ["passed", "failed"] as const
export type RestoreTestStatus = (typeof RESTORE_TEST_STATUSES)[number]

// ---------------------------------------------------------------------------
// Scheduling math (deterministic, pure)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const STEP_DAYS: Record<BackupFrequency, number> = { daily: 1, weekly: 7, monthly: 30 }

/**
 * Next UTC 02:00 boundary at/after which a policy of this frequency becomes
 * due, measured from `lastRunAt` (or `from` when it has never run). The 02:00
 * offset keeps automated backups just ahead of the 03:00 retention/export
 * sweeps so a fresh backup exists before anything is pruned.
 */
export function computeNextBackupRun(
  frequency: BackupFrequency,
  lastRunAt: Date | string | null,
  from: Date = new Date(),
): Date {
  const anchorSource = lastRunAt == null ? from : lastRunAt instanceof Date ? lastRunAt : new Date(lastRunAt)
  const anchor = Number.isNaN(anchorSource.getTime()) ? from : anchorSource
  const next = new Date(anchor)
  next.setUTCDate(next.getUTCDate() + STEP_DAYS[frequency])
  next.setUTCHours(2, 0, 0, 0)
  if (next.getTime() <= from.getTime()) {
    const bumped = new Date(from)
    bumped.setUTCHours(2, 0, 0, 0)
    if (bumped.getTime() <= from.getTime()) bumped.setTime(bumped.getTime() + DAY_MS)
    return bumped
  }
  return next
}

/**
 * Whether a backup should run now given when it last ran. A scope that has
 * never run is always due (so a newly-enabled policy backs up promptly).
 */
export function isBackupDue(
  frequency: BackupFrequency,
  lastRunAt: Date | string | null,
  now: Date = new Date(),
): boolean {
  if (lastRunAt == null) return true
  const next = computeNextBackupRun(frequency, lastRunAt, new Date(lastRunAt instanceof Date ? lastRunAt.getTime() : Date.parse(String(lastRunAt))))
  return next.getTime() <= now.getTime()
}

/** Whether an automatic restore test is due for a scope. */
export function isRestoreTestDue(
  cadence: RestoreTestFrequency,
  lastTestAt: Date | string | null,
  now: Date = new Date(),
): boolean {
  if (cadence === "none") return false
  if (lastTestAt == null) return true
  const last = lastTestAt instanceof Date ? lastTestAt : new Date(lastTestAt)
  if (Number.isNaN(last.getTime())) return true
  const stepDays = cadence === "weekly" ? 7 : 30
  return now.getTime() - last.getTime() >= stepDays * DAY_MS
}

// ---------------------------------------------------------------------------
// Retention / expiry
// ---------------------------------------------------------------------------

export const DEFAULT_RETENTION_DAYS = 30
export const MAX_RETENTION_DAYS = 3650 // 10 years
export const DEFAULT_MIN_KEEP = 3
export const MAX_MIN_KEEP = 100

export function clampRetentionDays(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS
  return Math.min(n, MAX_RETENTION_DAYS)
}

export function clampMinKeep(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_KEEP
  return Math.min(n, MAX_MIN_KEEP)
}

/** The timestamp a backup created at `createdAt` becomes eligible for pruning. */
export function computeExpiry(createdAt: Date | string, retentionDays: number): Date {
  const base = createdAt instanceof Date ? createdAt : new Date(createdAt)
  const anchor = Number.isNaN(base.getTime()) ? new Date() : base
  return new Date(anchor.getTime() + clampRetentionDays(retentionDays) * DAY_MS)
}

export function isBackupExpired(expiresAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() <= now.getTime()
}

// ---------------------------------------------------------------------------
// Artifact envelope
// ---------------------------------------------------------------------------

export const BACKUP_ARTIFACT_VERSION = 1
export const ENCRYPTION_ALGORITHM = "aes-256-gcm"

export type BackupSection = {
  /** Physical table name (database/config) or logical manifest name (files). */
  name: string
  rowCount: number
  rows: Record<string, unknown>[]
}

export type BackupArtifact = {
  version: number
  scope: BackupScope
  tenantId: number | null
  generatedAt: string
  sections: BackupSection[]
}

export function buildArtifactEnvelope(
  scope: BackupScope,
  tenantId: number | null,
  sections: BackupSection[],
  generatedAt: Date = new Date(),
): BackupArtifact {
  return {
    version: BACKUP_ARTIFACT_VERSION,
    scope,
    tenantId,
    generatedAt: generatedAt.toISOString(),
    sections,
  }
}

export function serializeArtifact(artifact: BackupArtifact): string {
  return JSON.stringify(artifact)
}

/** Parse + shape-validate a decrypted artifact. Returns null when malformed. */
export function parseArtifact(plaintext: string): BackupArtifact | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (!isBackupScope(obj.scope)) return null
  if (!Array.isArray(obj.sections)) return null
  const sections: BackupSection[] = []
  for (const raw of obj.sections) {
    if (!raw || typeof raw !== "object") return null
    const s = raw as Record<string, unknown>
    if (typeof s.name !== "string" || !Array.isArray(s.rows)) return null
    sections.push({
      name: s.name,
      rowCount: Number(s.rowCount ?? s.rows.length) || 0,
      rows: s.rows as Record<string, unknown>[],
    })
  }
  return {
    version: Number(obj.version) || BACKUP_ARTIFACT_VERSION,
    scope: obj.scope,
    tenantId: obj.tenantId == null ? null : Number(obj.tenantId),
    generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : new Date().toISOString(),
    sections,
  }
}

export function totalRowCount(sections: BackupSection[]): number {
  return sections.reduce((n, s) => n + (Number(s.rowCount) || 0), 0)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const value = n / 1024 ** i
  const text = value >= 100 || i === 0 || value % 1 === 0 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${units[i]}`
}
