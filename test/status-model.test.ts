import { describe, expect, it } from "vitest"
import {
  type RawIncidentEvent,
  deriveComponentStatus,
  incidentImpact,
  overallStatus,
  probeStatus,
  publicIncidentStatus,
  toPublicUpdates,
  validatePublicUpdate,
  worst,
} from "@/lib/status/model"

/**
 * Spec28 (#126) — Pure tests for the public-status derivation: measured health
 * probes + open incidents + platform maintenance combine into the worst honest
 * state, and the DR event log is translated into safe public updates.
 */

describe("probeStatus (measured health)", () => {
  it("maps probe results to component states", () => {
    expect(probeStatus(null)).toBe("unknown")
    expect(probeStatus({ ok: true })).toBe("operational")
    expect(probeStatus({ ok: true, latencyMs: 2000 })).toBe("degraded")
    expect(probeStatus({ ok: false })).toBe("major_outage")
  })
})

describe("deriveComponentStatus", () => {
  it("takes the worst of probe, incidents and maintenance", () => {
    expect(
      deriveComponentStatus({ probe: { ok: true }, openIncidentSeverities: [], inMaintenance: false }),
    ).toBe("operational")
    expect(
      deriveComponentStatus({ probe: { ok: true }, openIncidentSeverities: ["sev2"], inMaintenance: false }),
    ).toBe("partial_outage")
    expect(
      deriveComponentStatus({ probe: { ok: true }, openIncidentSeverities: ["sev3", "sev1"], inMaintenance: false }),
    ).toBe("major_outage")
  })

  it("labels an otherwise-healthy component as maintenance during a window", () => {
    expect(
      deriveComponentStatus({ probe: { ok: true }, openIncidentSeverities: [], inMaintenance: true }),
    ).toBe("maintenance")
  })

  it("still reports a real outage even during maintenance", () => {
    expect(
      deriveComponentStatus({ probe: { ok: false }, openIncidentSeverities: [], inMaintenance: true }),
    ).toBe("major_outage")
  })

  it("maps severity to impact", () => {
    expect(incidentImpact("sev1")).toBe("major_outage")
    expect(incidentImpact("sev2")).toBe("partial_outage")
    expect(incidentImpact("sev3")).toBe("degraded")
    expect(worst("operational", "degraded")).toBe("degraded")
  })
})

describe("overallStatus", () => {
  it("ignores unmeasured components but reports the worst measured one", () => {
    expect(overallStatus(["unknown", "unknown"])).toBe("unknown")
    expect(overallStatus(["operational", "unknown"])).toBe("operational")
    expect(overallStatus(["operational", "degraded", "unknown"])).toBe("degraded")
  })
})

describe("incident vocabulary translation", () => {
  it("maps internal DR statuses to public ones", () => {
    expect(publicIncidentStatus("declared")).toBe("investigating")
    expect(publicIncidentStatus("mitigating")).toBe("identified")
    expect(publicIncidentStatus("recovered")).toBe("monitoring")
    expect(publicIncidentStatus("closed")).toBe("resolved")
  })
})

describe("toPublicUpdates (incident update publishing)", () => {
  it("publishes declared/status_change/public_update and hides internal notes", () => {
    const events: RawIncidentEvent[] = [
      { kind: "declared", to_status: "declared", message: "", created_at: "2026-06-01 10:00:00" },
      { kind: "note", to_status: null, message: "internal only — paged oncall", created_at: "2026-06-01 10:05:00" },
      { kind: "status_change", to_status: "mitigating", message: "", created_at: "2026-06-01 10:30:00" },
      { kind: "public_update", to_status: null, message: "We expect recovery within the hour.", created_at: "2026-06-01 10:45:00" },
    ]
    const updates = toPublicUpdates(events)
    expect(updates).toHaveLength(3)
    expect(updates.some((u) => u.message.includes("internal only"))).toBe(false)
    expect(updates[0].status).toBe("investigating")
    expect(updates[1].status).toBe("identified")
    expect(updates[1].message).toMatch(/cause has been identified/i)
    expect(updates[2].message).toBe("We expect recovery within the hour.")
  })
})

describe("validatePublicUpdate (failure)", () => {
  it("rejects too-short and too-long messages, trims valid ones", () => {
    expect(validatePublicUpdate("hi")).toMatchObject({ ok: false })
    expect(validatePublicUpdate("x".repeat(1001))).toMatchObject({ ok: false })
    expect(validatePublicUpdate("  We are on it.  ")).toEqual({ ok: true, message: "We are on it." })
  })
})
