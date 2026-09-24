import { describe, expect, it } from "vitest"

/**
 * Data-region residency + drift rules. Pure logic, no DB.
 */
import {
  allowedRegionsFor,
  detectRegionDrift,
  isDataRegion,
  regionsCompatible,
  residencyGroupOf,
  validateRegionPlacement,
} from "@/lib/tenant-db/regions"

describe("region catalog + residency grouping", () => {
  it("recognises known regions and rejects unknown ones", () => {
    expect(isDataRegion("eu-west-1")).toBe(true)
    expect(isDataRegion("mars-1")).toBe(false)
    expect(isDataRegion(null)).toBe(false)
  })

  it("maps regions to their residency group", () => {
    expect(residencyGroupOf("eu-west-1")).toBe("eu")
    expect(residencyGroupOf("us-east-1")).toBe("us")
    expect(residencyGroupOf("ap-south-1")).toBe("apac")
  })

  it("lists only same-group regions as allowed for an anchor", () => {
    const allowed = allowedRegionsFor("eu-west-1").map((r) => r.id)
    expect(allowed).toContain("eu-west-1")
    expect(allowed).toContain("eu-central-1")
    expect(allowed).not.toContain("us-east-1")
  })

  it("treats regions as compatible only within one residency group", () => {
    expect(regionsCompatible("eu-west-1", "eu-central-1")).toBe(true)
    expect(regionsCompatible("eu-west-1", "us-east-1")).toBe(false)
    expect(regionsCompatible("eu-west-1", "mars-1")).toBe(false)
  })
})

describe("validateRegionPlacement enforces residency across db/storage/backup", () => {
  it("passes when every facet stays inside the anchor's group", () => {
    const violations = validateRegionPlacement("eu-west-1", {
      dbRegion: "eu-west-1",
      storageRegion: "eu-central-1",
      backupRegion: "eu-west-1",
    })
    expect(violations).toHaveLength(0)
  })

  it("flags a backup region outside the residency zone", () => {
    const violations = validateRegionPlacement("eu-west-1", {
      dbRegion: "eu-west-1",
      storageRegion: "eu-central-1",
      backupRegion: "us-east-1",
    })
    expect(violations).toHaveLength(1)
    expect(violations[0].facet).toBe("backup_region")
  })

  it("flags every cross-region facet at once", () => {
    const violations = validateRegionPlacement("eu-west-1", {
      dbRegion: "us-east-1",
      storageRegion: "ap-south-1",
      backupRegion: "us-west-2",
    })
    expect(violations.map((v) => v.facet).sort()).toEqual(["backup_region", "db_region", "storage_region"])
  })

  it("requires a valid anchor before evaluating placement", () => {
    const violations = validateRegionPlacement("nope", { dbRegion: "eu-west-1" })
    expect(violations).toHaveLength(1)
    expect(violations[0].facet).toBe("data_region")
  })

  it("does not treat an unset facet as a violation", () => {
    const violations = validateRegionPlacement("eu-west-1", { dbRegion: "eu-west-1" })
    expect(violations).toHaveLength(0)
  })
})

describe("detectRegionDrift", () => {
  it("reports no drift when configured and resolved regions match", () => {
    expect(detectRegionDrift("eu-west-1", "eu-west-1").drifted).toBe(false)
  })
  it("reports drift on any mismatch", () => {
    const d = detectRegionDrift("eu-west-1", "eu-central-1")
    expect(d.drifted).toBe(true)
    expect(d.expected).toBe("eu-west-1")
    expect(d.actual).toBe("eu-central-1")
  })
  it("treats an unknown/absent resolved region as drift", () => {
    expect(detectRegionDrift("eu-west-1", null).drifted).toBe(true)
  })
})
