import { describe, expect, it } from "vitest"
import {
  type BypassActor,
  type MaintenanceWindow,
  canBypassMaintenance,
  gateDecision,
  isEmergencyPath,
  isMaintenanceExemptPath,
  moduleKeyForPath,
  phaseOf,
  resolveMaintenance,
  retryAfterSeconds,
  userMessage,
  validateWindowInput,
} from "@/lib/maintenance/model"

/**
 * Spec28 (#125) — Pure, DB-free tests for the maintenance model: scheduled
 * window phases, cross-tenant isolation, bypass permissions, the edge gate
 * decision, request-path exemptions, and create-request validation.
 */

const NOW = new Date("2026-06-01T12:00:00.000Z")

function win(over: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: 1,
    scope: "platform",
    tenantId: null,
    moduleKey: null,
    title: "Scheduled maintenance",
    message: "",
    startsAt: "2026-06-01T10:00:00.000Z",
    endsAt: "2026-06-01T14:00:00.000Z",
    status: "scheduled",
    ...over,
  }
}

describe("phaseOf (scheduled window lifecycle)", () => {
  it("classifies upcoming, active and ended by clock", () => {
    expect(phaseOf(win({ startsAt: "2026-06-01T13:00:00.000Z", endsAt: "2026-06-01T15:00:00.000Z" }), NOW)).toBe("upcoming")
    expect(phaseOf(win(), NOW)).toBe("active")
    expect(phaseOf(win({ startsAt: "2026-06-01T08:00:00.000Z", endsAt: "2026-06-01T11:00:00.000Z" }), NOW)).toBe("ended")
  })

  it("treats an open-ended active window as active and honors terminal statuses", () => {
    expect(phaseOf(win({ endsAt: null }), NOW)).toBe("active")
    expect(phaseOf(win({ status: "cancelled" }), NOW)).toBe("cancelled")
    expect(phaseOf(win({ status: "completed" }), NOW)).toBe("ended")
  })
})

describe("resolveMaintenance (tenant isolation)", () => {
  it("platform maintenance applies to every tenant", () => {
    const r = resolveMaintenance([win({ scope: "platform" })], { tenantId: 42 }, NOW)
    expect(r.active?.scope).toBe("platform")
  })

  it("a tenant window never leaks to another tenant", () => {
    const windows = [win({ id: 2, scope: "tenant", tenantId: 7, endsAt: null })]
    expect(resolveMaintenance(windows, { tenantId: 7 }, NOW).active?.id).toBe(2)
    expect(resolveMaintenance(windows, { tenantId: 8 }, NOW).active).toBeNull()
  })

  it("an all-tenant module window disables that module for everyone", () => {
    const windows = [win({ id: 3, scope: "module", tenantId: null, moduleKey: "finance", endsAt: null })]
    const r = resolveMaintenance(windows, { tenantId: 99, moduleKey: "finance" }, NOW)
    expect(r.active?.id).toBe(3)
    expect(r.activeModules).toContain("finance")
    // A different module for the same tenant is unaffected.
    expect(resolveMaintenance(windows, { tenantId: 99, moduleKey: "hr" }, NOW).active).toBeNull()
  })

  it("prefers the broadest active scope (platform over tenant)", () => {
    const windows = [
      win({ id: 4, scope: "tenant", tenantId: 7, endsAt: null }),
      win({ id: 5, scope: "platform", endsAt: null }),
    ]
    expect(resolveMaintenance(windows, { tenantId: 7 }, NOW).active?.scope).toBe("platform")
  })

  it("surfaces upcoming windows within the announce horizon", () => {
    const upcoming = win({ id: 6, startsAt: "2026-06-02T00:00:00.000Z", endsAt: "2026-06-02T02:00:00.000Z" })
    const r = resolveMaintenance([upcoming], { tenantId: 1 }, NOW)
    expect(r.active).toBeNull()
    expect(r.upcoming.map((w) => w.id)).toEqual([6])
  })
})

describe("canBypassMaintenance (permissions)", () => {
  const platformWin = win({ scope: "platform", endsAt: null })
  const tenantWin = win({ scope: "tenant", tenantId: 7, endsAt: null })

  const actor = (over: Partial<BypassActor>): BypassActor => ({
    platformRole: "none",
    tenantRole: "employee",
    tenantId: 7,
    ...over,
  })

  it("only a platform super admin bypasses platform maintenance", () => {
    expect(canBypassMaintenance(platformWin, actor({ platformRole: "platform_super_admin" }))).toBe(true)
    expect(canBypassMaintenance(platformWin, actor({ platformRole: "platform_staff" }))).toBe(false)
    expect(canBypassMaintenance(platformWin, actor({ tenantRole: "tenant_owner" }))).toBe(false)
  })

  it("a tenant admin bypasses only their OWN tenant's window", () => {
    expect(canBypassMaintenance(tenantWin, actor({ tenantRole: "tenant_admin", tenantId: 7 }))).toBe(true)
    expect(canBypassMaintenance(tenantWin, actor({ tenantRole: "tenant_admin", tenantId: 8 }))).toBe(false)
    expect(canBypassMaintenance(tenantWin, actor({ tenantRole: "employee", tenantId: 7 }))).toBe(false)
  })
})

describe("gateDecision (edge first pass)", () => {
  const active = [win({ scope: "platform", endsAt: null })]

  it("allows when nothing is active", () => {
    expect(gateDecision([], { tenantId: 1 }, null, NOW).action).toBe("allow")
  })

  it("blocks an unauthenticated request during an active window", () => {
    expect(gateDecision(active, { tenantId: 1 }, null, NOW).action).toBe("block")
  })

  it("defers to a DB re-check when the token claims a bypass role", () => {
    expect(gateDecision(active, { tenantId: 1 }, { platformRole: "platform_super_admin" }, NOW).action).toBe("verify")
  })

  it("blocks a token that claims no bypass-worthy role", () => {
    expect(gateDecision(active, { tenantId: 1 }, { tenantRole: "employee" }, NOW).action).toBe("block")
  })
})

describe("request-path exemptions", () => {
  it("keeps health, status, auth and platform reachable in any maintenance", () => {
    expect(isEmergencyPath("/api/health")).toBe(true)
    expect(isEmergencyPath("/api/platform/tenants")).toBe(true)
    expect(isEmergencyPath("/api/finance/invoices")).toBe(false)
  })

  it("also exempts the maintenance screen, support desk and crons", () => {
    expect(isMaintenanceExemptPath("/maintenance")).toBe(true)
    expect(isMaintenanceExemptPath("/api/tenant/support-tickets")).toBe(true)
    expect(isMaintenanceExemptPath("/api/cron/support-sla")).toBe(true)
    expect(isMaintenanceExemptPath("/api/finance/invoices")).toBe(false)
  })
})

describe("moduleKeyForPath", () => {
  it("maps route segments onto catalog module keys", () => {
    expect(moduleKeyForPath("/api/finance/invoices")).toBe("finance")
    expect(moduleKeyForPath("/api/sales/leads")).toBe("crm")
    expect(moduleKeyForPath("/modules/hr/people")).toBe("hr")
    expect(moduleKeyForPath("/login")).toBeNull()
  })
})

describe("retryAfterSeconds & userMessage", () => {
  it("returns seconds until the window ends, floored at 60", () => {
    expect(retryAfterSeconds(win({ endsAt: "2026-06-01T12:30:00.000Z" }), NOW)).toBe(1800)
    expect(retryAfterSeconds(win({ endsAt: "2026-06-01T12:00:30.000Z" }), NOW)).toBe(60)
    expect(retryAfterSeconds(win({ endsAt: null }), NOW)).toBeNull()
  })

  it("phrases the user message per scope", () => {
    expect(userMessage(win({ scope: "platform" }))).toMatch(/Muenot is undergoing/)
    expect(userMessage(win({ scope: "tenant", tenantId: 7 }))).toMatch(/Your workspace/)
    expect(userMessage(win({ scope: "module", moduleKey: "finance" }))).toMatch(/Finance & Accounting/)
    expect(userMessage(win({ scope: "platform", message: "Back at 2pm." }))).toMatch(/Back at 2pm\.$/)
  })
})

describe("validateWindowInput (failure & normalization)", () => {
  it("rejects scope/target mismatches", () => {
    expect(validateWindowInput({ scope: "platform", title: "abc", tenantId: 7 }, NOW)).toMatchObject({ ok: false })
    expect(validateWindowInput({ scope: "tenant", title: "abc" }, NOW)).toMatchObject({ ok: false })
    expect(validateWindowInput({ scope: "module", title: "abc", moduleKey: "" }, NOW)).toMatchObject({ ok: false })
  })

  it("rejects bad titles and date ranges", () => {
    expect(validateWindowInput({ scope: "platform", title: "xy" }, NOW)).toMatchObject({ ok: false })
    expect(
      validateWindowInput({ scope: "platform", title: "valid title", startsAt: "2026-05-01T00:00:00Z" }, NOW),
    ).toMatchObject({ ok: false })
    expect(
      validateWindowInput(
        { scope: "platform", title: "valid title", startsAt: "2026-06-01T13:00:00Z", endsAt: "2026-06-01T12:00:00Z" },
        NOW,
      ),
    ).toMatchObject({ ok: false })
    expect(
      validateWindowInput(
        { scope: "platform", title: "valid title", startsAt: "2026-06-01T13:00:00Z", endsAt: "2026-06-30T13:00:00Z" },
        NOW,
      ),
    ).toMatchObject({ ok: false })
  })

  it("normalizes a valid platform window and drops any module key", () => {
    const res = validateWindowInput(
      { scope: "platform", title: "Database upgrade", message: "  brief  ", startsAt: "2026-06-01T13:00:00Z" },
      NOW,
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.tenantId).toBeNull()
      expect(res.value.moduleKey).toBeNull()
      expect(res.value.message).toBe("brief")
      expect(res.value.endsAt).toBeNull()
    }
  })

  it("normalizes a valid module window", () => {
    const res = validateWindowInput({ scope: "module", title: "Finance freeze", moduleKey: "FINANCE", tenantId: 7 }, NOW)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.scope).toBe("module")
      expect(res.value.moduleKey).toBe("finance")
      expect(res.value.tenantId).toBe(7)
    }
  })
})
