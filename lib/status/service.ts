import "server-only"
/**
 * Spec28 (#126) — Public status assembly from MEASURED health + DR incidents +
 * platform maintenance. Reuses:
 *   • lib/health.ts probes (database round-trip, storage configuration),
 *   • `system_health_checks` (last measured result written by system monitoring),
 *   • the DR incident workflow (platform_dr_incidents / _events).
 * Only platform-wide information is published; tenant windows/tickets never are.
 */
import { createHash } from "node:crypto"
import { query } from "@/lib/db"
import { checkDatabase, checkStorage } from "@/lib/health"
import { listIncidents, getIncident, type DrIncident } from "@/lib/dr/store"
import { recordAuditLog } from "@/lib/audit-log-store"
import { getActivePlatformWindows } from "@/lib/maintenance/store"
import { phaseOf } from "@/lib/maintenance/model"
import {
  STATUS_COMPONENTS,
  STATUS_LABELS,
  type ComponentStatus,
  type ProbeInput,
  type PublicUpdate,
  type Severity,
  type StatusComponentKey,
  deriveComponentStatus,
  overallStatus,
  publicIncidentStatus,
  toPublicUpdates,
} from "@/lib/status/model"

export type PublicComponent = { key: StatusComponentKey; label: string; status: ComponentStatus; statusLabel: string; checkedAt: string }
export type PublicIncident = {
  reference: string
  title: string
  impact: Severity
  status: ReturnType<typeof publicIncidentStatus>
  components: StatusComponentKey[]
  startedAt: string
  resolvedAt: string | null
  updates: PublicUpdate[]
}
export type PublicStatus = {
  overall: ComponentStatus
  overallLabel: string
  generatedAt: string
  components: PublicComponent[]
  activeIncidents: PublicIncident[]
  recentIncidents: PublicIncident[]
  maintenance: { title: string; message: string; startsAt: string; endsAt: string | null; phase: "upcoming" | "active" }[]
}

async function lastMeasured(): Promise<Map<string, { status: string }>> {
  try {
    const rows = await query<{ name: string; status: string }[]>(
      "SELECT `name`, `status` FROM `system_health_checks` WHERE `last_checked_at` > (UTC_TIMESTAMP() - INTERVAL 15 MINUTE)",
    )
    return new Map(rows.map((r) => [r.name.toLowerCase(), { status: r.status }]))
  } catch {
    return new Map()
  }
}

function recordedProbe(rec: { status: string } | undefined): ProbeInput {
  if (!rec || rec.status === "UNKNOWN") return null
  return { ok: rec.status !== "DOWN", latencyMs: rec.status === "DEGRADED" ? Number.MAX_SAFE_INTEGER : null }
}

async function measure(): Promise<Record<StatusComponentKey, ProbeInput>> {
  const [db, recorded] = await Promise.all([checkDatabase(), lastMeasured()])
  const storage = checkStorage()
  return {
    // The request is being served, so the application tier is up; a recent
    // DOWN/DEGRADED measurement from system monitoring still wins.
    application: recordedProbe(recorded.get("application")) ?? { ok: true, latencyMs: null },
    database: { ok: db.ok, latencyMs: db.latencyMs },
    files: storage.ok ? recordedProbe(recorded.get("blob storage")) ?? { ok: true, latencyMs: null } : null,
    config: recordedProbe(recorded.get("configuration")),
  }
}

function toPublicIncident(i: DrIncident, updates: PublicUpdate[]): PublicIncident {
  return {
    reference: i.reference,
    title: i.title,
    impact: i.severity,
    status: publicIncidentStatus(i.status),
    components: i.serviceKey ? [i.serviceKey as StatusComponentKey] : STATUS_COMPONENTS.map((c) => c.key),
    startedAt: i.declaredAt,
    resolvedAt: i.resolvedAt,
    updates,
  }
}

const OPEN = new Set(["declared", "investigating", "mitigating"])
const RECENT_DAYS = 14

let cache: { at: number; value: PublicStatus } | null = null
const CACHE_MS = 30_000

export function invalidateStatusCache(): void {
  cache = null
}

export async function getPublicStatus(now = new Date()): Promise<PublicStatus> {
  if (cache && now.getTime() - cache.at < CACHE_MS) return cache.value
  const [probes, incidents, windows] = await Promise.all([
    measure(),
    listIncidents(100).catch(() => [] as DrIncident[]),
    getActivePlatformWindows(now).catch(() => []),
  ])
  const open = incidents.filter((i) => OPEN.has(i.status))
  const cutoff = now.getTime() - RECENT_DAYS * 86_400_000
  const recent = incidents.filter((i) => !OPEN.has(i.status) && Date.parse(`${i.declaredAt.replace(" ", "T")}Z`) >= cutoff).slice(0, 10)
  const maintenanceActive = windows.some((w) => phaseOf(w, now) === "active")

  const components: PublicComponent[] = STATUS_COMPONENTS.map((c) => {
    const severities = open.filter((i) => !i.serviceKey || i.serviceKey === c.key).map((i) => i.severity as Severity)
    const status = deriveComponentStatus({ probe: probes[c.key], openIncidentSeverities: severities, inMaintenance: maintenanceActive })
    return { key: c.key, label: c.label, status, statusLabel: STATUS_LABELS[status], checkedAt: now.toISOString() }
  })

  const withUpdates = async (i: DrIncident) => {
    const full = await getIncident(i.id).catch(() => null)
    const events = (full?.events ?? []).map((e) => ({ kind: e.kind, to_status: e.toStatus, message: e.message, created_at: e.createdAt }))
    return toPublicIncident(i, toPublicUpdates(events).reverse())
  }

  const overall = overallStatus(components.map((c) => c.status))
  const value: PublicStatus = {
    overall,
    overallLabel: overall === "operational" ? "All systems operational" : STATUS_LABELS[overall],
    generatedAt: now.toISOString(),
    components,
    activeIncidents: await Promise.all(open.map(withUpdates)),
    recentIncidents: await Promise.all(recent.map(withUpdates)),
    maintenance: windows.map((w) => ({
      title: w.title,
      message: w.message,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      phase: phaseOf(w, now) === "active" ? ("active" as const) : ("upcoming" as const),
    })),
  }
  cache = { at: now.getTime(), value }
  return value
}

/**
 * Post a customer-facing update to an existing DR incident. Stored in the DR
 * event log as kind `public_update` (internal `note`s stay private).
 * Idempotent per (incident, key) via a deterministic marker in the message row.
 */
export async function publishIncidentUpdate(
  incidentId: number,
  message: string,
  actor: { userId: number },
  idempotencyKey: string | null,
): Promise<{ replayed: boolean }> {
  const found = await getIncident(incidentId)
  if (!found) {
    const err = new Error("Incident not found") as Error & { status: number }
    err.status = 404
    throw err
  }
  const kind = "public_update"
  // from_status is unused for public updates; it carries a 16-char digest of
  // the Idempotency-Key so retries are detected without a DR schema change.
  const marker = idempotencyKey ? `i:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 14)}` : null
  if (marker) {
    const prior = await query<{ id: number }[]>(
      "SELECT `id` FROM `platform_dr_incident_events` WHERE `incident_id` = ? AND `kind` = ? AND `from_status` = ? LIMIT 1",
      [incidentId, kind, marker],
    )
    if (prior[0]) return { replayed: true }
  }
  await query(
    "INSERT INTO `platform_dr_incident_events` (`incident_id`, `kind`, `from_status`, `message`, `actor_user_id`) VALUES (?, ?, ?, ?, ?)",
    [incidentId, kind, marker, message, actor.userId],
  )
  invalidateStatusCache()
  await recordAuditLog({
    action: "status.incident_public_update",
    entityType: "dr_incident",
    entityId: String(incidentId),
    entityLabel: found.incident.reference,
    result: "success",
    after: { length: message.length },
  }).catch(() => {})
  return { replayed: false }
}
