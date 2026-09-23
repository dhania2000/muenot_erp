import { describe, expect, it } from "vitest"
import {
  DR_SERVICES,
  canTransitionIncident,
  clampRpoMinutes,
  clampRtoMinutes,
  computeReadiness,
  formatDuration,
  nextIncidentStatuses,
  rollUpReadiness,
  toDrDrillType,
  toDrIncidentStatus,
  toDrServiceKey,
  toDrSeverity,
} from "@/lib/dr/model"

/**
 * Phase 2/4. Pure, DB-free validation of the disaster-recovery model:
 * objective normalization + formatting, honest readiness derivation, roll-up,
 * and the incident lifecycle state machine.
 */

describe("normalization", () => {
  it("coerces service keys", () => {
    expect(toDrServiceKey("database")).toBe("database")
    expect(toDrServiceKey("application")).toBe("application")
    expect(toDrServiceKey("nope")).toBeNull()
    expect(toDrServiceKey(5)).toBeNull()
  })

  it("coerces drill types, severities and statuses", () => {
    expect(toDrDrillType("restore")).toBe("restore")
    expect(toDrDrillType("boom")).toBeNull()
    expect(toDrSeverity("sev1")).toBe("sev1")
    expect(toDrSeverity("whatever")).toBe("sev3")
    expect(toDrIncidentStatus("mitigating")).toBe("mitigating")
    expect(toDrIncidentStatus("done")).toBeNull()
  })

  it("clamps objectives", () => {
    expect(clampRpoMinutes(-10)).toBe(0)
    expect(clampRpoMinutes(0)).toBe(0)
    expect(clampRpoMinutes(1_000_000)).toBe(525_600)
    expect(clampRtoMinutes(0)).toBe(1)
    expect(clampRtoMinutes(30)).toBe(30)
    expect(clampRtoMinutes("bad")).toBe(1)
  })
})

describe("formatDuration", () => {
  it("renders human durations", () => {
    expect(formatDuration(0)).toBe("0m")
    expect(formatDuration(30)).toBe("30m")
    expect(formatDuration(60)).toBe("1h")
    expect(formatDuration(240)).toBe("4h")
    expect(formatDuration(1440)).toBe("1d")
    expect(formatDuration(10080)).toBe("7d")
    expect(formatDuration(90)).toBe("1h 30m")
  })
})

describe("computeReadiness", () => {
  it("is unknown for a stateful service with no backup dependency", () => {
    const r = computeReadiness({
      stateless: false, backupConfigured: false, rpoBreached: null,
      lastRestorePassed: null, lastDrillStatus: null, drillStale: false,
    })
    expect(r.level).toBe("unknown")
  })

  it("is ready only when everything is proven and current", () => {
    const r = computeReadiness({
      stateless: false, backupConfigured: true, rpoBreached: false,
      lastRestorePassed: true, lastDrillStatus: "passed", drillStale: false,
    })
    expect(r.level).toBe("ready")
  })

  it("degrades to not_ready on any proven failure", () => {
    expect(
      computeReadiness({
        stateless: false, backupConfigured: true, rpoBreached: true,
        lastRestorePassed: true, lastDrillStatus: "passed", drillStale: false,
      }).level,
    ).toBe("not_ready")
    expect(
      computeReadiness({
        stateless: false, backupConfigured: true, rpoBreached: false,
        lastRestorePassed: false, lastDrillStatus: "passed", drillStale: false,
      }).level,
    ).toBe("not_ready")
    expect(
      computeReadiness({
        stateless: false, backupConfigured: true, rpoBreached: false,
        lastRestorePassed: true, lastDrillStatus: "failed", drillStale: false,
      }).level,
    ).toBe("not_ready")
  })

  it("degrades to at_risk when readiness is merely unproven", () => {
    expect(
      computeReadiness({
        stateless: false, backupConfigured: true, rpoBreached: false,
        lastRestorePassed: true, lastDrillStatus: null, drillStale: false,
      }).level,
    ).toBe("at_risk")
    expect(
      computeReadiness({
        stateless: false, backupConfigured: true, rpoBreached: false,
        lastRestorePassed: true, lastDrillStatus: "passed", drillStale: true,
      }).level,
    ).toBe("at_risk")
  })

  it("evaluates a stateless service on drills alone", () => {
    expect(
      computeReadiness({
        stateless: true, backupConfigured: false, rpoBreached: null,
        lastRestorePassed: null, lastDrillStatus: "passed", drillStale: false,
      }).level,
    ).toBe("ready")
    expect(
      computeReadiness({
        stateless: true, backupConfigured: false, rpoBreached: null,
        lastRestorePassed: null, lastDrillStatus: null, drillStale: false,
      }).level,
    ).toBe("at_risk")
  })
})

describe("rollUpReadiness", () => {
  it("takes the worst posture", () => {
    expect(rollUpReadiness([])).toBe("unknown")
    expect(rollUpReadiness(["unknown", "unknown"])).toBe("unknown")
    expect(rollUpReadiness(["ready", "ready"])).toBe("ready")
    expect(rollUpReadiness(["ready", "at_risk"])).toBe("at_risk")
    expect(rollUpReadiness(["ready", "unknown"])).toBe("at_risk")
    expect(rollUpReadiness(["ready", "at_risk", "not_ready"])).toBe("not_ready")
  })
})

describe("incident lifecycle", () => {
  it("only allows forward-ish transitions and terminates at closed", () => {
    expect(canTransitionIncident("declared", "investigating")).toBe(true)
    expect(canTransitionIncident("declared", "recovered")).toBe(false)
    expect(canTransitionIncident("mitigating", "recovered")).toBe(true)
    expect(canTransitionIncident("recovered", "closed")).toBe(true)
    expect(canTransitionIncident("closed", "investigating")).toBe(false)
    expect(nextIncidentStatuses("closed")).toEqual([])
  })
})

describe("catalog", () => {
  it("covers the four critical services with sane defaults", () => {
    expect(DR_SERVICES.map((s) => s.key)).toEqual(["database", "files", "config", "application"])
    const app = DR_SERVICES.find((s) => s.key === "application")!
    expect(app.backupScope).toBeNull()
    expect(app.defaultRpoMinutes).toBe(0)
    const db = DR_SERVICES.find((s) => s.key === "database")!
    expect(db.backupScope).toBe("database")
    expect(db.defaultRtoMinutes).toBeGreaterThan(0)
  })
})
