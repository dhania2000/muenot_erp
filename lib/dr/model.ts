import type { BackupScope } from "@/lib/backup/model"

/**
 * SPEC 76 — Disaster Recovery model (pure, DB-free).
 * ---------------------------------------------------------------------------
 * The disaster-recovery plan is expressed as a small, reviewed catalog of
 * critical services (Phase 1). Each service carries recovery objectives — RPO
 * and RTO (Phase 2) — and a recovery mechanism that, where the service holds
 * state, is anchored to a real SPEC 75 backup scope (Phase 3). Readiness is
 * NEVER asserted; it is derived from real backup recency, restore-test outcome
 * and drill history (Phase 4). This module owns only the pure math and the
 * catalog so it can be unit-tested without a database.
 */

// ---------------------------------------------------------------------------
// Critical-service catalog (Phase 1)
// ---------------------------------------------------------------------------

export const DR_SERVICE_KEYS = ["database", "files", "config", "application"] as const
export type DrServiceKey = (typeof DR_SERVICE_KEYS)[number]

/** Business criticality tier — orders the recovery sequence during an event. */
export const DR_TIERS = ["critical", "high", "standard"] as const
export type DrTier = (typeof DR_TIERS)[number]

export type DrServiceDefinition = {
  key: DrServiceKey
  label: string
  description: string
  /** The state this service depends on. `null` means the tier is stateless. */
  backupScope: BackupScope | null
  tier: DrTier
  /** Recovery Point Objective — maximum tolerable data loss, in minutes. */
  defaultRpoMinutes: number
  /** Recovery Time Objective — maximum tolerable downtime, in minutes. */
  defaultRtoMinutes: number
  recoveryMethod: string
  failoverStrategy: string
}

const DAY = 60 * 24
const HOUR = 60

export const DR_SERVICES: readonly DrServiceDefinition[] = [
  {
    key: "database",
    label: "Primary database",
    description: "Transactional system of record for every tenant.",
    backupScope: "database",
    tier: "critical",
    defaultRpoMinutes: DAY,
    defaultRtoMinutes: 4 * HOUR,
    recoveryMethod: "Restore the latest verified logical snapshot, then replay point-in-time binlog.",
    failoverStrategy: "Promote the standby replica; repoint the connection reference.",
  },
  {
    key: "files",
    label: "File / object storage",
    description: "Uploaded documents, attachments and generated artifacts.",
    backupScope: "files",
    tier: "high",
    defaultRpoMinutes: DAY,
    defaultRtoMinutes: 4 * HOUR,
    recoveryMethod: "Rehydrate objects from the latest verified file-manifest snapshot.",
    failoverStrategy: "Serve from the cross-region replica bucket.",
  },
  {
    key: "config",
    label: "Configuration & secrets",
    description: "Platform configuration, feature flags and secret references.",
    backupScope: "config",
    tier: "high",
    defaultRpoMinutes: 7 * DAY,
    defaultRtoMinutes: 2 * HOUR,
    recoveryMethod: "Re-apply the latest verified configuration snapshot.",
    failoverStrategy: "Reload configuration into the recovered environment.",
  },
  {
    key: "application",
    label: "Application tier",
    description: "Stateless request-handling deployment.",
    backupScope: null,
    tier: "critical",
    defaultRpoMinutes: 0,
    defaultRtoMinutes: 30,
    recoveryMethod: "Redeploy the pinned build; no state to restore.",
    failoverStrategy: "Shift traffic to a healthy region behind the load balancer.",
  },
]

const SERVICE_MAP = new Map<DrServiceKey, DrServiceDefinition>(DR_SERVICES.map((s) => [s.key, s]))

export function getDrServiceDefinition(key: string): DrServiceDefinition | null {
  return SERVICE_MAP.get(key as DrServiceKey) ?? null
}

export function toDrServiceKey(value: unknown): DrServiceKey | null {
  return typeof value === "string" && SERVICE_MAP.has(value as DrServiceKey) ? (value as DrServiceKey) : null
}

export function toDrTier(value: unknown): DrTier {
  return DR_TIERS.includes(value as DrTier) ? (value as DrTier) : "standard"
}

// ---------------------------------------------------------------------------
// Objective normalization (Phase 2)
// ---------------------------------------------------------------------------

/** RPO may be 0 for stateless tiers; RTO must be positive. Capped at one year. */
export function clampRpoMinutes(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, 525_600)
}

export function clampRtoMinutes(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, 525_600)
}

/** Human-friendly duration for objectives: "0m", "30m", "4h", "7d". */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes))
  if (m === 0) return "0m"
  if (m % DAY === 0) return `${m / DAY}d`
  if (m % HOUR === 0) return `${m / HOUR}h`
  if (m < HOUR) return `${m}m`
  const h = Math.floor(m / HOUR)
  const rem = m % HOUR
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`
}

// ---------------------------------------------------------------------------
// Drills & incidents (Phase 4 + incident workflow)
// ---------------------------------------------------------------------------

export const DR_DRILL_TYPES = ["restore", "failover", "tabletop"] as const
export type DrDrillType = (typeof DR_DRILL_TYPES)[number]

export function toDrDrillType(value: unknown): DrDrillType | null {
  return DR_DRILL_TYPES.includes(value as DrDrillType) ? (value as DrDrillType) : null
}

export const DR_DRILL_STATUSES = ["passed", "partial", "failed"] as const
export type DrDrillStatus = (typeof DR_DRILL_STATUSES)[number]

export const DR_SEVERITIES = ["sev1", "sev2", "sev3"] as const
export type DrSeverity = (typeof DR_SEVERITIES)[number]

export function toDrSeverity(value: unknown): DrSeverity {
  return DR_SEVERITIES.includes(value as DrSeverity) ? (value as DrSeverity) : "sev3"
}

export const DR_SEVERITY_LABELS: Record<DrSeverity, string> = {
  sev1: "SEV-1 · Critical",
  sev2: "SEV-2 · Major",
  sev3: "SEV-3 · Minor",
}

/**
 * Incident lifecycle. A declared incident is investigated, mitigated, recovered
 * (service restored) and finally closed after review. `closed` is terminal.
 */
export const DR_INCIDENT_STATUSES = ["declared", "investigating", "mitigating", "recovered", "closed"] as const
export type DrIncidentStatus = (typeof DR_INCIDENT_STATUSES)[number]

const INCIDENT_TRANSITIONS: Record<DrIncidentStatus, DrIncidentStatus[]> = {
  declared: ["investigating", "mitigating", "closed"],
  investigating: ["mitigating", "recovered", "closed"],
  mitigating: ["recovered", "investigating", "closed"],
  recovered: ["closed", "investigating"],
  closed: [],
}

export function nextIncidentStatuses(from: DrIncidentStatus): DrIncidentStatus[] {
  return INCIDENT_TRANSITIONS[from] ?? []
}

export function canTransitionIncident(from: DrIncidentStatus, to: DrIncidentStatus): boolean {
  return nextIncidentStatuses(from).includes(to)
}

export function toDrIncidentStatus(value: unknown): DrIncidentStatus | null {
  return DR_INCIDENT_STATUSES.includes(value as DrIncidentStatus) ? (value as DrIncidentStatus) : null
}

export function isIncidentOpen(status: DrIncidentStatus): boolean {
  return status !== "closed"
}

// ---------------------------------------------------------------------------
// Readiness derivation (Phase 4) — the heart of honest reporting
// ---------------------------------------------------------------------------

export const DR_READINESS_LEVELS = ["ready", "at_risk", "not_ready", "unknown"] as const
export type DrReadiness = (typeof DR_READINESS_LEVELS)[number]

const READINESS_RANK: Record<Exclude<DrReadiness, "unknown">, number> = {
  ready: 0,
  at_risk: 1,
  not_ready: 2,
}

export type ReadinessInput = {
  /** Stateless services carry no backup dependency; readiness rests on drills. */
  stateless: boolean
  /** A backup policy is enabled OR a completed backup exists for the scope. */
  backupConfigured: boolean
  /** true = newest recovery point older than RPO; null = not measurable yet. */
  rpoBreached: boolean | null
  /** Outcome of the newest restore test for the scope; null = never tested. */
  lastRestorePassed: boolean | null
  /** Outcome of the newest recovery drill; null = never drilled. */
  lastDrillStatus: DrDrillStatus | null
  /** The newest drill is older than the review cadence. */
  drillStale: boolean
}

export type ReadinessResult = {
  level: DrReadiness
  reasons: string[]
}

/**
 * Derive a readiness level from real signals. The guiding rule: a service can
 * only reach `ready` when its recovery point is within RPO, its restore has
 * been verified and its most recent drill passed and is current. Anything
 * unproven degrades to `at_risk`; a proven failure degrades to `not_ready`;
 * a stateful service with no backup dependency at all is `unknown`.
 */
export function computeReadiness(input: ReadinessInput): ReadinessResult {
  if (!input.stateless && !input.backupConfigured) {
    return { level: "unknown", reasons: ["No backup dependency is configured for this service."] }
  }

  const reasons: string[] = []
  let level: Exclude<DrReadiness, "unknown"> = "ready"
  const downgrade = (to: Exclude<DrReadiness, "unknown">, reason: string) => {
    if (READINESS_RANK[to] > READINESS_RANK[level]) level = to
    reasons.push(reason)
  }

  // Proven failures.
  if (input.rpoBreached === true) downgrade("not_ready", "Newest recovery point is older than the RPO target.")
  if (input.lastRestorePassed === false) downgrade("not_ready", "The last restore verification failed.")
  if (input.lastDrillStatus === "failed") downgrade("not_ready", "The last recovery drill failed.")

  // Unproven readiness.
  if (input.lastDrillStatus == null) downgrade("at_risk", "No recovery drill has been run yet.")
  else if (input.lastDrillStatus === "partial") downgrade("at_risk", "The last recovery drill only partially succeeded.")
  else if (input.drillStale) downgrade("at_risk", "The last recovery drill is overdue for its review cadence.")

  if (!input.stateless && input.lastRestorePassed == null) {
    downgrade("at_risk", "Backup restore has not been verified.")
  }
  if (!input.stateless && input.rpoBreached === null) {
    downgrade("at_risk", "No recovery point exists yet, so RPO cannot be measured.")
  }

  if (reasons.length === 0) reasons.push("RPO met, restore verified and the latest drill passed.")
  return { level, reasons }
}

export const DR_READINESS_LABELS: Record<DrReadiness, string> = {
  ready: "Ready",
  at_risk: "At risk",
  not_ready: "Not ready",
  unknown: "Unknown",
}

/**
 * Roll individual service readiness up to a single posture. The overall posture
 * is the worst service posture, treating `unknown` as unproven (at_risk-equiv)
 * unless everything is unknown.
 */
export function rollUpReadiness(levels: DrReadiness[]): DrReadiness {
  if (levels.length === 0) return "unknown"
  if (levels.every((l) => l === "unknown")) return "unknown"
  if (levels.includes("not_ready")) return "not_ready"
  if (levels.includes("at_risk") || levels.includes("unknown")) return "at_risk"
  return "ready"
}
