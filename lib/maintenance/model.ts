/**
 * Spec28 (#125) — Maintenance mode. PURE model: no I/O, fully unit-testable.
 *
 * A maintenance window has a SCOPE:
 *   • platform — every tenant, every module (set by platform super admins).
 *   • tenant   — one tenant's whole workspace.
 *   • module   — one module, either for one tenant or (tenantId null) for all.
 *
 * Windows are SCHEDULED (start/end) rather than a bare boolean so users get
 * advance notice, the switch turns itself off, and the audit trail shows exactly
 * when the service was unavailable. "Switch on now" is a window starting now
 * with no end.
 */

export const MAINTENANCE_SCOPES = ["platform", "tenant", "module"] as const
export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number]

export const MAINTENANCE_STATUSES = ["scheduled", "completed", "cancelled"] as const
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number]

export type MaintenancePhase = "upcoming" | "active" | "ended" | "cancelled"

export type MaintenanceWindow = {
  id: number
  scope: MaintenanceScope
  tenantId: number | null
  moduleKey: string | null
  title: string
  message: string
  startsAt: string
  endsAt: string | null
  status: MaintenanceStatus
}

export type MaintenanceTarget = { tenantId: number | null; moduleKey?: string | null }

/** Max length of a single window. Longer outages should be split, not left on. */
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** How far ahead upcoming windows are announced to users. */
export const ANNOUNCE_AHEAD_MS = 7 * 24 * 60 * 60 * 1000
const MODULE_KEY_RE = /^[a-z][a-z0-9_-]{1,40}$/

/**
 * Paths that must stay reachable during ANY maintenance: liveness/readiness
 * probes (load balancers), the public status page, sign-in (so admins can get
 * in), and the platform console (emergency operations, itself gated to staff).
 */
export const EMERGENCY_PATH_PREFIXES = [
  "/api/health",
  "/api/status",
  "/status",
  "/api/auth",
  "/login",
  "/api/platform",
  "/platform",
] as const

export function isEmergencyPath(pathname: string): boolean {
  return EMERGENCY_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

function ts(value: string | null): number {
  if (!value) return Number.NaN
  // DB rows come back as "YYYY-MM-DD HH:MM:SS" (UTC); treat them as UTC.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value) ? `${value.replace(" ", "T")}Z` : value
  return Date.parse(iso)
}

export function phaseOf(w: MaintenanceWindow, now: Date = new Date()): MaintenancePhase {
  if (w.status === "cancelled") return "cancelled"
  if (w.status === "completed") return "ended"
  const t = now.getTime()
  if (t < ts(w.startsAt)) return "upcoming"
  const end = ts(w.endsAt)
  if (Number.isFinite(end) && t >= end) return "ended"
  return "active"
}

/** Whether a window covers the target tenant/module. Never leaks across tenants. */
export function appliesTo(w: MaintenanceWindow, target: MaintenanceTarget): boolean {
  if (w.scope === "platform") return true
  if (w.scope === "tenant") return target.tenantId != null && w.tenantId === target.tenantId
  // module scope
  if (!target.moduleKey || w.moduleKey !== target.moduleKey) return false
  return w.tenantId == null || (target.tenantId != null && w.tenantId === target.tenantId)
}

const SCOPE_RANK: Record<MaintenanceScope, number> = { platform: 3, tenant: 2, module: 1 }

export type MaintenanceResolution = {
  /** The broadest ACTIVE window covering the target, or null. */
  active: MaintenanceWindow | null
  /** Active module windows for the tenant (for disabling individual modules). */
  activeModules: string[]
  /** Upcoming windows within the announce horizon, soonest first. */
  upcoming: MaintenanceWindow[]
}

export function resolveMaintenance(
  windows: MaintenanceWindow[],
  target: MaintenanceTarget,
  now: Date = new Date(),
): MaintenanceResolution {
  let active: MaintenanceWindow | null = null
  const activeModules = new Set<string>()
  const upcoming: MaintenanceWindow[] = []
  for (const w of windows) {
    const phase = phaseOf(w, now)
    const tenantMatch =
      w.scope === "platform" ||
      (target.tenantId != null && w.tenantId === target.tenantId) ||
      (w.scope === "module" && w.tenantId == null)
    if (!tenantMatch) continue
    if (phase === "active") {
      if (w.scope === "module" && w.moduleKey) activeModules.add(w.moduleKey)
      if (appliesTo(w, target) && (!active || SCOPE_RANK[w.scope] > SCOPE_RANK[active.scope])) active = w
    } else if (phase === "upcoming" && ts(w.startsAt) - now.getTime() <= ANNOUNCE_AHEAD_MS) {
      upcoming.push(w)
    }
  }
  upcoming.sort((a, b) => ts(a.startsAt) - ts(b.startsAt))
  return { active, activeModules: [...activeModules].sort(), upcoming }
}

export type BypassActor = {
  platformRole: "none" | "platform_staff" | "platform_super_admin"
  tenantRole: "employee" | "module_admin" | "tenant_admin" | "tenant_owner"
  tenantId: number | null
}

/**
 * Who may keep working through an ACTIVE window (to verify the fix before
 * reopening). Strict: platform-wide maintenance is bypassed only by platform
 * super admins; tenant/module maintenance additionally by that SAME tenant's
 * admins/owners. Platform staff and ordinary users never bypass.
 */
export function canBypassMaintenance(w: MaintenanceWindow, actor: BypassActor): boolean {
  if (actor.platformRole === "platform_super_admin") return true
  if (w.scope === "platform") return false
  const isTenantAdmin = actor.tenantRole === "tenant_admin" || actor.tenantRole === "tenant_owner"
  return isTenantAdmin && w.tenantId != null && w.tenantId === actor.tenantId
}

export function retryAfterSeconds(w: MaintenanceWindow, now: Date = new Date()): number | null {
  const end = ts(w.endsAt)
  if (!Number.isFinite(end)) return null
  return Math.max(60, Math.ceil((end - now.getTime()) / 1000))
}

export function userMessage(w: MaintenanceWindow): string {
  const who =
    w.scope === "platform"
      ? "Muenot is undergoing scheduled maintenance."
      : w.scope === "tenant"
        ? "Your workspace is undergoing maintenance."
        : `The ${w.moduleKey} module is undergoing maintenance.`
  return w.message ? `${who} ${w.message}` : who
}

export type WindowInput = {
  scope: MaintenanceScope
  tenantId: number | null
  moduleKey: string | null
  title: string
  message: string
  startsAt: string
  endsAt: string | null
}

export type ValidationResult = { ok: true; value: WindowInput } | { ok: false; error: string }

/** Validate and normalize a create request. Scope/tenant consistency is enforced here. */
export function validateWindowInput(raw: Record<string, unknown>, now: Date = new Date()): ValidationResult {
  const scope = String(raw.scope ?? "") as MaintenanceScope
  if (!MAINTENANCE_SCOPES.includes(scope)) return { ok: false, error: "scope must be platform, tenant or module" }

  const title = typeof raw.title === "string" ? raw.title.trim() : ""
  if (title.length < 3 || title.length > 200) return { ok: false, error: "title must be 3-200 characters" }
  const message = typeof raw.message === "string" ? raw.message.trim() : ""
  if (message.length > 1000) return { ok: false, error: "message must be at most 1000 characters" }

  const tenantRaw = raw.tenantId
  const tenantId = tenantRaw == null || tenantRaw === "" ? null : Number(tenantRaw)
  if (tenantId != null && (!Number.isSafeInteger(tenantId) || tenantId <= 0)) return { ok: false, error: "tenantId is invalid" }

  const moduleKey = typeof raw.moduleKey === "string" && raw.moduleKey.trim() ? raw.moduleKey.trim().toLowerCase() : null
  if (scope === "platform" && (tenantId != null || moduleKey)) {
    return { ok: false, error: "platform maintenance cannot target a tenant or module" }
  }
  if (scope === "tenant" && (tenantId == null || moduleKey)) {
    return { ok: false, error: "tenant maintenance requires a tenantId and no module" }
  }
  if (scope === "module" && (!moduleKey || !MODULE_KEY_RE.test(moduleKey))) {
    return { ok: false, error: "module maintenance requires a valid moduleKey" }
  }

  const start = raw.startsAt == null || raw.startsAt === "" ? now.getTime() : Date.parse(String(raw.startsAt))
  if (!Number.isFinite(start)) return { ok: false, error: "startsAt is not a valid date" }
  if (start < now.getTime() - 5 * 60 * 1000) return { ok: false, error: "startsAt cannot be in the past" }
  let end: number | null = null
  if (raw.endsAt != null && raw.endsAt !== "") {
    end = Date.parse(String(raw.endsAt))
    if (!Number.isFinite(end)) return { ok: false, error: "endsAt is not a valid date" }
    if (end <= start) return { ok: false, error: "endsAt must be after startsAt" }
    if (end - start > MAX_WINDOW_MS) return { ok: false, error: "a window can last at most 7 days" }
  }

  return {
    ok: true,
    value: {
      scope,
      tenantId,
      moduleKey: scope === "module" ? moduleKey : null,
      title,
      message,
      startsAt: new Date(start).toISOString(),
      endsAt: end == null ? null : new Date(end).toISOString(),
    },
  }
}

/** ISO → MySQL DATETIME (UTC). */
export function toDbDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ")
}
