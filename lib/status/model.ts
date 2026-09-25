/**
 * Spec28 (#126) — Public component status. PURE derivation.
 *
 * Status is DERIVED, never typed in: each component's state is the worst of
 *   (a) its latest measured health probe,
 *   (b) open DR incidents against that component (severity → impact), and
 *   (c) an active PLATFORM maintenance window.
 * Components map 1:1 onto the DR service catalog so the incident workflow and
 * the public page share one vocabulary. Tenant-specific data never appears.
 */

export const STATUS_COMPONENTS = [
  { key: "application", label: "Web application & API" },
  { key: "database", label: "Database" },
  { key: "files", label: "File storage" },
  { key: "config", label: "Configuration & secrets" },
] as const
export type StatusComponentKey = (typeof STATUS_COMPONENTS)[number]["key"]

export const COMPONENT_STATUSES = [
  "operational",
  "unknown",
  "maintenance",
  "degraded",
  "partial_outage",
  "major_outage",
] as const
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number]

const RANK: Record<ComponentStatus, number> = {
  operational: 0,
  unknown: 1,
  maintenance: 2,
  degraded: 3,
  partial_outage: 4,
  major_outage: 5,
}

export const STATUS_LABELS: Record<ComponentStatus, string> = {
  operational: "Operational",
  unknown: "Not measured",
  maintenance: "Under maintenance",
  degraded: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
}

export function worst(a: ComponentStatus, b: ComponentStatus): ComponentStatus {
  return RANK[b] > RANK[a] ? b : a
}

/** Probe result: `null` means the component is not measured in this runtime. */
export type ProbeInput = { ok: boolean; latencyMs?: number | null } | null

/** A latency above this on an otherwise-OK probe reports as degraded. */
export const DEGRADED_LATENCY_MS = 1500

export function probeStatus(probe: ProbeInput): ComponentStatus {
  if (!probe) return "unknown"
  if (!probe.ok) return "major_outage"
  if (probe.latencyMs != null && probe.latencyMs > DEGRADED_LATENCY_MS) return "degraded"
  return "operational"
}

export type Severity = "sev1" | "sev2" | "sev3"

export function incidentImpact(severity: Severity): ComponentStatus {
  return severity === "sev1" ? "major_outage" : severity === "sev2" ? "partial_outage" : "degraded"
}

export type DeriveInput = {
  probe: ProbeInput
  openIncidentSeverities: Severity[]
  inMaintenance: boolean
}

export function deriveComponentStatus(input: DeriveInput): ComponentStatus {
  let status = probeStatus(input.probe)
  for (const s of input.openIncidentSeverities) status = worst(status, incidentImpact(s))
  // Maintenance explains an otherwise-unknown/operational state; a measured
  // outage during maintenance is still reported as the outage.
  if (input.inMaintenance && RANK[status] < RANK.maintenance) status = "maintenance"
  return status
}

export function overallStatus(statuses: ComponentStatus[]): ComponentStatus {
  // Unmeasured components alone must not make the whole platform look broken.
  const measured = statuses.filter((s) => s !== "unknown")
  if (measured.length === 0) return "unknown"
  return measured.reduce(worst, "operational" as ComponentStatus)
}

/** Internal DR workflow → public incident vocabulary. */
export type PublicIncidentStatus = "investigating" | "identified" | "monitoring" | "resolved"
export function publicIncidentStatus(drStatus: string): PublicIncidentStatus {
  switch (drStatus) {
    case "mitigating":
      return "identified"
    case "recovered":
      return "monitoring"
    case "closed":
      return "resolved"
    default:
      return "investigating"
  }
}

/** Event kinds that are safe to publish. Internal `note`s are never public. */
export const PUBLIC_EVENT_KINDS = ["declared", "status_change", "public_update"] as const

export type RawIncidentEvent = {
  kind: string
  to_status: string | null
  message: string
  created_at: string
}

export type PublicUpdate = { status: PublicIncidentStatus | null; message: string; at: string }

export function toPublicUpdates(events: RawIncidentEvent[]): PublicUpdate[] {
  return events
    .filter((e) => (PUBLIC_EVENT_KINDS as readonly string[]).includes(e.kind))
    .map((e) => ({
      status: e.to_status ? publicIncidentStatus(e.to_status) : null,
      // declared/status_change messages are system-generated; public_update is
      // written by staff specifically for customers.
      message: e.kind === "public_update" ? e.message : e.kind === "declared" ? "We are investigating this issue." : statusSentence(e.to_status),
      at: e.created_at,
    }))
}

function statusSentence(to: string | null): string {
  switch (publicIncidentStatus(to ?? "")) {
    case "identified":
      return "The cause has been identified and a fix is being applied."
    case "monitoring":
      return "A fix has been applied and we are monitoring the results."
    case "resolved":
      return "This incident has been resolved."
    default:
      return "We are investigating this issue."
  }
}

export const MAX_PUBLIC_UPDATE_LENGTH = 1000

export function validatePublicUpdate(raw: unknown): { ok: true; message: string } | { ok: false; error: string } {
  const message = typeof raw === "string" ? raw.trim() : ""
  if (message.length < 5) return { ok: false, error: "update message must be at least 5 characters" }
  if (message.length > MAX_PUBLIC_UPDATE_LENGTH) return { ok: false, error: "update message is too long" }
  return { ok: true, message }
}
