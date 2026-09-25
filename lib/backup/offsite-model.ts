/**
 * Off-site backup + disaster-recovery model (pure, DB-free, Node-free).
 * ---------------------------------------------------------------------------
 * Spec10 (#43-45) extends the backup engine so an encrypted artifact is written
 * to INDEPENDENT object storage (not only a MySQL row), copied to a second
 * region, held under an immutable retention window, and later restored into an
 * ISOLATED temporary database to prove it is recoverable.
 *
 * This module owns only the deterministic decisions that can be unit-tested
 * without a database, a network, or a `node:*` import:
 *   - reading + redacting the off-site storage configuration from the env,
 *   - the deterministic object-key layout (tenant-specific recovery points),
 *   - immutable retention / delete-eligibility math,
 *   - large-artifact upload planning (single PUT vs. multipart),
 *   - interrupted-upload retry classification + backoff,
 *   - key-loss detection when a stored artifact cannot be decrypted,
 *   - safe isolated-restore temp-database + identifier naming.
 *
 * The real S3 / filesystem driver, DB store wiring and drill execution live in
 * lib/backup/offsite-store.ts and lib/backup/store.ts.
 */

// ---------------------------------------------------------------------------
// Configuration (env-driven, independent of the primary database)
// ---------------------------------------------------------------------------

export type OffsiteMode = "s3" | "local" | "disabled"

export type OffsiteEndpoint = {
  bucket: string
  region: string
  endpoint: string | null
  prefix: string
}

export type OffsiteConfig = {
  mode: OffsiteMode
  /** Reason the sink is disabled, for honest UI messaging. */
  disabledReason: string | null
  primary: OffsiteEndpoint | null
  /** The cross-region replica target, when configured. */
  replica: OffsiteEndpoint | null
  /** When true, objects are written under a WORM retention window. */
  immutable: boolean
  /** Object-lock mode requested for S3 (COMPLIANCE cannot be shortened). */
  lockMode: "GOVERNANCE" | "COMPLIANCE"
  /** Filesystem root for the local sink (dev / self-hosted without S3). */
  localDir: string | null
  /** Minimum days an object is retained even if the policy asks for less. */
  minImmutableDays: number
}

export type EnvLike = Record<string, string | undefined>

function str(env: EnvLike, key: string): string | null {
  const v = env[key]
  if (typeof v !== "string") return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
}

function bool(env: EnvLike, key: string, fallback = false): boolean {
  const v = str(env, key)
  if (v == null) return fallback
  return ["1", "true", "yes", "on"].includes(v.toLowerCase())
}

function normalizePrefix(value: string | null): string {
  if (!value) return "backups"
  return value.replace(/^\/+|\/+$/g, "") || "backups"
}

/**
 * Resolve the off-site backup configuration from the environment. Precedence:
 *   1. An S3 bucket (`BACKUP_OFFSITE_BUCKET`) → real independent object storage.
 *   2. A local directory (`BACKUP_OFFSITE_LOCAL_DIR`) → a filesystem sink that
 *      still lives OUTSIDE the database, usable in dev / self-hosted installs.
 *   3. Otherwise disabled — the engine falls back to the inline MySQL blob and
 *      the UI says so honestly.
 */
export function readOffsiteConfig(env: EnvLike = process.env as EnvLike): OffsiteConfig {
  const immutable = bool(env, "BACKUP_OFFSITE_IMMUTABLE", true)
  const lockMode = (str(env, "BACKUP_OFFSITE_LOCK_MODE") || "GOVERNANCE").toUpperCase() === "COMPLIANCE"
    ? "COMPLIANCE"
    : "GOVERNANCE"
  const minImmutableDays = Math.max(1, Math.min(3650, Math.floor(Number(str(env, "BACKUP_OFFSITE_MIN_IMMUTABLE_DAYS")) || 7)))
  const prefix = normalizePrefix(str(env, "BACKUP_OFFSITE_PREFIX"))

  const bucket = str(env, "BACKUP_OFFSITE_BUCKET")
  if (bucket) {
    const region = str(env, "BACKUP_OFFSITE_REGION") || "us-east-1"
    const endpoint = str(env, "BACKUP_OFFSITE_ENDPOINT")
    const replicaBucket = str(env, "BACKUP_OFFSITE_REPLICA_BUCKET")
    const replica: OffsiteEndpoint | null = replicaBucket
      ? {
          bucket: replicaBucket,
          region: str(env, "BACKUP_OFFSITE_REPLICA_REGION") || region,
          endpoint: str(env, "BACKUP_OFFSITE_REPLICA_ENDPOINT") || endpoint,
          prefix,
        }
      : null
    return {
      mode: "s3",
      disabledReason: null,
      primary: { bucket, region, endpoint, prefix },
      replica,
      immutable,
      lockMode,
      localDir: null,
      minImmutableDays,
    }
  }

  const localDir = str(env, "BACKUP_OFFSITE_LOCAL_DIR")
  if (localDir) {
    const replicaDir = str(env, "BACKUP_OFFSITE_REPLICA_LOCAL_DIR")
    return {
      mode: "local",
      disabledReason: null,
      primary: { bucket: localDir, region: "local", endpoint: null, prefix },
      replica: replicaDir ? { bucket: replicaDir, region: "local-replica", endpoint: null, prefix } : null,
      immutable,
      lockMode,
      localDir,
      minImmutableDays,
    }
  }

  return {
    mode: "disabled",
    disabledReason:
      "No off-site target configured. Set BACKUP_OFFSITE_BUCKET (S3-compatible) or BACKUP_OFFSITE_LOCAL_DIR to store encrypted backups independently of MySQL.",
    primary: null,
    replica: null,
    immutable,
    lockMode,
    localDir: null,
    minImmutableDays,
  }
}

/** A redacted, UI-safe summary of the off-site configuration (no secrets). */
export type OffsiteStatus = {
  mode: OffsiteMode
  enabled: boolean
  disabledReason: string | null
  immutable: boolean
  lockMode: string
  crossRegion: boolean
  primaryRegion: string | null
  replicaRegion: string | null
  minImmutableDays: number
}

export function describeOffsite(config: OffsiteConfig): OffsiteStatus {
  return {
    mode: config.mode,
    enabled: config.mode !== "disabled",
    disabledReason: config.disabledReason,
    immutable: config.immutable,
    lockMode: config.lockMode,
    crossRegion: config.replica != null,
    primaryRegion: config.primary?.region ?? null,
    replicaRegion: config.replica?.region ?? null,
    minImmutableDays: config.minImmutableDays,
  }
}

// ---------------------------------------------------------------------------
// Object-key layout (tenant-specific recovery points)
// ---------------------------------------------------------------------------

export type ObjectKeyParts = {
  prefix: string
  tenantId: number | null
  scope: string
  runId: number
  generatedAt: Date | string
}

/**
 * Deterministic, collision-free object key. Every recovery point is filed under
 * its tenant + scope so a tenant's points are enumerable and isolated:
 *   <prefix>/tenant-<id>/<scope>/<YYYY>/<MM>/run-<runId>-<epochms>.bin.enc
 */
export function buildObjectKey(parts: ObjectKeyParts): string {
  const prefix = normalizePrefix(parts.prefix)
  const tenant = parts.tenantId == null ? "platform" : `tenant-${parts.tenantId}`
  const scope = /^[a-z0-9_]+$/i.test(parts.scope) ? parts.scope : "unknown"
  const d = parts.generatedAt instanceof Date ? parts.generatedAt : new Date(parts.generatedAt)
  const at = Number.isNaN(d.getTime()) ? new Date() : d
  const yyyy = at.getUTCFullYear()
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0")
  return `${prefix}/${tenant}/${scope}/${yyyy}/${mm}/run-${parts.runId}-${at.getTime()}.bin.enc`
}

// ---------------------------------------------------------------------------
// Immutable retention math
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/**
 * The instant before which an object must not be deleted. It is the later of
 * the policy retention window and the configured immutable floor, so shortening
 * a policy can never expose a backup to premature deletion.
 */
export function computeRetainUntil(
  createdAt: Date | string,
  retentionDays: number,
  minImmutableDays: number,
): Date {
  const base = createdAt instanceof Date ? createdAt : new Date(createdAt)
  const anchor = Number.isNaN(base.getTime()) ? new Date() : base
  const days = Math.max(Math.floor(retentionDays) || 0, Math.floor(minImmutableDays) || 0, 1)
  return new Date(anchor.getTime() + days * DAY_MS)
}

/** Whether an immutable object may be deleted yet. */
export function isDeleteAllowed(
  retainUntil: Date | string | null | undefined,
  immutable: boolean,
  now: Date = new Date(),
): boolean {
  if (!immutable) return true
  if (!retainUntil) return true
  const d = retainUntil instanceof Date ? retainUntil : new Date(retainUntil)
  if (Number.isNaN(d.getTime())) return true
  return now.getTime() >= d.getTime()
}

// ---------------------------------------------------------------------------
// Large-artifact upload planning
// ---------------------------------------------------------------------------

export const MIN_PART_SIZE = 5 * 1024 * 1024 // S3 multipart minimum
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024
export const MULTIPART_THRESHOLD = 16 * 1024 * 1024

export type UploadPlan = {
  multipart: boolean
  partSize: number
  partCount: number
  totalBytes: number
}

/**
 * Decide how to transfer `totalBytes`. Small artifacts go in a single PUT; large
 * ones are split into >=5MB parts so an interrupted transfer can resume a part
 * instead of restarting the whole upload.
 */
export function planUpload(
  totalBytes: number,
  partSize: number = DEFAULT_PART_SIZE,
  threshold: number = MULTIPART_THRESHOLD,
): UploadPlan {
  const total = Math.max(0, Math.floor(totalBytes))
  if (total <= threshold) {
    return { multipart: false, partSize: total, partCount: total === 0 ? 0 : 1, totalBytes: total }
  }
  const size = Math.max(MIN_PART_SIZE, Math.floor(partSize))
  const partCount = Math.max(1, Math.ceil(total / size))
  return { multipart: true, partSize: size, partCount, totalBytes: total }
}

/** The byte range [start, end) for part number `partNumber` (1-based). */
export function partRange(plan: UploadPlan, partNumber: number): { start: number; end: number } {
  const idx = Math.max(1, Math.floor(partNumber)) - 1
  const start = idx * plan.partSize
  const end = Math.min(plan.totalBytes, start + plan.partSize)
  return { start, end }
}

// ---------------------------------------------------------------------------
// Interrupted-upload retry classification + backoff
// ---------------------------------------------------------------------------

export type UploadErrorClass = "transient" | "auth" | "immutable" | "fatal"

const TRANSIENT_NAMES = new Set([
  "RequestTimeout",
  "RequestTimeoutException",
  "PriorRequestNotComplete",
  "ConnectionError",
  "TimeoutError",
  "ThrottlingException",
  "SlowDown",
  "InternalError",
  "ServiceUnavailable",
])
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"])
const AUTH_NAMES = new Set([
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "CredentialsProviderError",
  "InvalidToken",
  "ExpiredToken",
  "AccessDenied",
])

/** Classify a storage failure so the driver knows whether a retry can help. */
export function classifyUploadError(err: unknown): UploadErrorClass {
  const e = err as { name?: string; code?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number } }
  const name = e?.name || e?.Code || ""
  const code = e?.code || ""
  const status = e?.$metadata?.httpStatusCode
  const message = String(e?.message || "").toLowerCase()

  if (message.includes("object lock") || message.includes("worm") || message.includes("retention") || message.includes("compliance")) {
    return "immutable"
  }
  if (TRANSIENT_CODES.has(code) || TRANSIENT_NAMES.has(name)) return "transient"
  if (status != null && (status === 429 || status >= 500)) return "transient"
  if (AUTH_NAMES.has(name) || status === 401 || status === 403) return "auth"
  return "fatal"
}

export function shouldRetryUpload(cls: UploadErrorClass, attempt: number, maxAttempts: number): boolean {
  return cls === "transient" && attempt < maxAttempts
}

/** Exponential backoff with a cap, deterministic (no jitter) for testability. */
export function nextRetryDelayMs(attempt: number, baseMs = 200, maxMs = 5_000): number {
  const a = Math.max(1, Math.floor(attempt))
  return Math.min(maxMs, baseMs * 2 ** (a - 1))
}

// ---------------------------------------------------------------------------
// Key-loss detection (restore integrity)
// ---------------------------------------------------------------------------

export type ArtifactReadFailure = "key_mismatch" | "corrupt" | "missing" | "unknown"

/**
 * Classify why a stored artifact could not be turned back into plaintext. An
 * authenticated-decryption failure (GCM tag mismatch) means the encryption key
 * is wrong or lost — a distinct, actionable condition from plain corruption.
 */
export function classifyArtifactReadFailure(err: unknown): ArtifactReadFailure {
  const message = String((err as { message?: string })?.message || err || "").toLowerCase()
  if (
    message.includes("unable to authenticate") ||
    message.includes("unsupported state") ||
    message.includes("auth tag") ||
    message.includes("bad decrypt") ||
    message.includes("wrong final block")
  ) {
    return "key_mismatch"
  }
  if (message.includes("not found") || message.includes("nosuchkey") || message.includes("enoent")) return "missing"
  if (message.includes("parse") || message.includes("json") || message.includes("checksum")) return "corrupt"
  return "unknown"
}

export function describeArtifactReadFailure(kind: ArtifactReadFailure): string {
  switch (kind) {
    case "key_mismatch":
      return "The backup could not be decrypted — the encryption key is missing or has changed since the backup was written."
    case "missing":
      return "The stored backup object could not be found in off-site storage."
    case "corrupt":
      return "The backup object was found but its contents are corrupt or fail integrity checks."
    default:
      return "The backup object could not be read."
  }
}

// ---------------------------------------------------------------------------
// Isolated-restore identifiers (verified restore drills into temp databases)
// ---------------------------------------------------------------------------

export const TEMP_DB_PREFIX = "mnt_restore_"

/**
 * A safe, unique name for the throwaway database a restore drill materializes
 * into. The random token prevents collisions between concurrent drills; the
 * fixed prefix lets an operator recognize and sweep orphaned drill databases.
 */
export function buildTempDatabaseName(runId: number, token: string): string {
  const safeToken = String(token).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "0"
  const safeRun = Math.max(0, Math.floor(Number(runId) || 0))
  return `${TEMP_DB_PREFIX}r${safeRun}_${safeToken}`.slice(0, 64)
}

/** Only ever operate on a database we created — never a real schema. */
export function isSafeTempDatabaseName(name: string): boolean {
  return typeof name === "string" && name.startsWith(TEMP_DB_PREFIX) && /^[a-z0-9_]{1,64}$/.test(name)
}

/** A table/column identifier is safe to interpolate only if strictly [A-Za-z0-9_]. */
export function isSafeIdentifier(name: string): boolean {
  return typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name)
}

// ---------------------------------------------------------------------------
// Measured recovery posture (RPO / RTO / evidence)
// ---------------------------------------------------------------------------

/**
 * The subset of a backup run needed to measure recovery posture. Kept
 * structural (not tied to the store type) so this stays a pure, DB-free
 * function that can be unit-tested with plain fixtures.
 */
export type RecoveryPointLike = {
  status: string
  createdAt: string | Date | null
  finishedAt?: string | Date | null
  verificationStatus?: string | null
  verifiedAt?: string | Date | null
  storageLocation?: string | null
  immutable?: boolean | null
  replicaRegion?: string | null
}

/** The subset of a restore drill needed as recovery evidence. */
export type RestoreEvidenceLike = {
  status: string
  createdAt: string | Date | null
  durationMs?: number | null
  tempDatabase?: string | null
  restoredRows?: number | null
  mode?: string | null
}

export type RecoveryPosture = {
  /** True once at least one completed backup exists, so RPO can be measured. */
  measurable: boolean
  /** Newest backup run of any status, ISO string. */
  latestBackupAt: string | null
  /** Newest completed (recoverable) backup, ISO string. */
  latestSuccessfulBackupAt: string | null
  /**
   * Measured Recovery Point Objective exposure: minutes of data at risk right
   * now = time since the newest completed backup. null when unmeasurable.
   */
  rpoMinutes: number | null
  /**
   * Measured Recovery Time Objective: how long the most recent PASSED restore
   * drill took to rebuild the data, in minutes (ceil, min 1 when non-zero).
   * null when no passing drill has ever run.
   */
  rtoMinutes: number | null
  /** Raw duration of the RTO-defining drill, for precise UI formatting. */
  rtoDurationMs: number | null
  lastVerificationStatus: string | null
  lastVerifiedAt: string | null
  lastDrillStatus: string | null
  lastDrillAt: string | null
  lastDrillTempDatabase: string | null
  lastDrillRestoredRows: number | null
  lastDrillDurationMs: number | null
  /** Count of completed runs whose artifact lives in off-site object storage. */
  offsiteCount: number
  /** Count of completed runs held under an immutable retention window. */
  immutableCount: number
  /** Count of completed runs copied to a second region. */
  crossRegionCount: number
  totalCompleted: number
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Measure recovery posture from actual backup runs and restore drills — never
 * fabricated. RPO is the live data-loss window (time since the newest completed
 * backup); RTO is the wall-clock time the most recent passing drill needed to
 * rebuild the data. Both stay null until there is real evidence to report.
 */
export function summarizeRecoveryPosture(
  runs: RecoveryPointLike[],
  drills: RestoreEvidenceLike[],
  now: Date = new Date(),
): RecoveryPosture {
  const completed = runs.filter((r) => r.status === "completed")

  let latestBackup: Date | null = null
  for (const r of runs) {
    const d = toDate(r.createdAt)
    if (d && (!latestBackup || d.getTime() > latestBackup.getTime())) latestBackup = d
  }

  // Newest completed backup by its completion time (finishedAt ?? createdAt).
  let latestGood: Date | null = null
  let latestGoodRun: RecoveryPointLike | null = null
  for (const r of completed) {
    const d = toDate(r.finishedAt) ?? toDate(r.createdAt)
    if (d && (!latestGood || d.getTime() > latestGood.getTime())) {
      latestGood = d
      latestGoodRun = r
    }
  }

  const rpoMinutes =
    latestGood != null ? Math.max(0, Math.floor((now.getTime() - latestGood.getTime()) / 60_000)) : null

  // Most recent drill of any status = evidence; most recent PASSED drill = RTO.
  let lastDrill: RestoreEvidenceLike | null = null
  let lastPassedDrill: RestoreEvidenceLike | null = null
  let lastDrillAt: Date | null = null
  let lastPassedAt: Date | null = null
  for (const t of drills) {
    const d = toDate(t.createdAt)
    if (!d) continue
    if (!lastDrillAt || d.getTime() > lastDrillAt.getTime()) {
      lastDrillAt = d
      lastDrill = t
    }
    if (t.status === "passed" && (!lastPassedAt || d.getTime() > lastPassedAt.getTime())) {
      lastPassedAt = d
      lastPassedDrill = t
    }
  }

  const rtoDurationMs =
    lastPassedDrill != null && typeof lastPassedDrill.durationMs === "number" && lastPassedDrill.durationMs >= 0
      ? Math.floor(lastPassedDrill.durationMs)
      : null
  const rtoMinutes = rtoDurationMs == null ? null : rtoDurationMs === 0 ? 0 : Math.max(1, Math.ceil(rtoDurationMs / 60_000))

  return {
    measurable: latestGood != null,
    latestBackupAt: latestBackup ? latestBackup.toISOString() : null,
    latestSuccessfulBackupAt: latestGood ? latestGood.toISOString() : null,
    rpoMinutes,
    rtoMinutes,
    rtoDurationMs,
    lastVerificationStatus: latestGoodRun?.verificationStatus ?? null,
    lastVerifiedAt: toDate(latestGoodRun?.verifiedAt)?.toISOString() ?? null,
    lastDrillStatus: lastDrill?.status ?? null,
    lastDrillAt: lastDrillAt ? lastDrillAt.toISOString() : null,
    lastDrillTempDatabase: lastDrill?.tempDatabase ?? null,
    lastDrillRestoredRows: lastDrill && typeof lastDrill.restoredRows === "number" ? lastDrill.restoredRows : null,
    lastDrillDurationMs: lastDrill && typeof lastDrill.durationMs === "number" ? lastDrill.durationMs : null,
    offsiteCount: completed.filter((r) => r.storageLocation === "offsite").length,
    immutableCount: completed.filter((r) => r.storageLocation === "offsite" && r.immutable === true).length,
    crossRegionCount: completed.filter((r) => r.storageLocation === "offsite" && !!r.replicaRegion).length,
    totalCompleted: completed.length,
  }
}
