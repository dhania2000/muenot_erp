import { describe, expect, it } from "vitest"
import {
  canRestoreVersion,
  formatVersionLabel,
  normalizeVersionAuditAction,
  supportsVersioning,
} from "@/lib/storage/file-versions"

/**
 * SPEC 33 — Phase 4. Pure, DB-free validation of the versioning policy layer:
 * the audit-action vocabulary, version labels, which files are versionable,
 * and — most importantly — the restore permission model.
 */

describe("version audit action vocabulary", () => {
  it("passes through the four known actions", () => {
    for (const a of ["uploaded", "restored", "downloaded", "deleted"] as const) {
      expect(normalizeVersionAuditAction(a)).toBe(a)
    }
  })

  it("falls back to 'uploaded' for unknown/empty values", () => {
    expect(normalizeVersionAuditAction("garbage")).toBe("uploaded")
    expect(normalizeVersionAuditAction(null)).toBe("uploaded")
    expect(normalizeVersionAuditAction(undefined)).toBe("uploaded")
  })
})

describe("version labels", () => {
  it("prefixes with v and floors to a positive integer", () => {
    expect(formatVersionLabel(1)).toBe("v1")
    expect(formatVersionLabel(12)).toBe("v12")
    expect(formatVersionLabel(0)).toBe("v1")
    expect(formatVersionLabel(3.9)).toBe("v3")
  })
})

describe("versionability", () => {
  it("requires both an entity anchor and a filename", () => {
    expect(supportsVersioning({ entityType: "invoice", filename: "inv.pdf" })).toBe(true)
    expect(supportsVersioning({ entityType: null, filename: "inv.pdf" })).toBe(false)
    expect(supportsVersioning({ entityType: "invoice", filename: null })).toBe(false)
    expect(supportsVersioning({ entityType: null, filename: null })).toBe(false)
  })
})

describe("restore permissions", () => {
  const adminActor = { userId: 1, role: "admin" as const }
  const employeeActor = { userId: 7, role: "employee" as const }

  it("lets an admin restore any file in their tenant", () => {
    expect(canRestoreVersion(adminActor, { ownerId: 999 })).toBe(true)
    expect(canRestoreVersion(adminActor, { ownerId: null })).toBe(true)
  })

  it("lets a non-admin restore only files they own", () => {
    expect(canRestoreVersion(employeeActor, { ownerId: 7 })).toBe(true)
    expect(canRestoreVersion(employeeActor, { ownerId: 8 })).toBe(false)
  })

  it("denies a non-admin when ownership is unknown (fail closed)", () => {
    expect(canRestoreVersion(employeeActor, { ownerId: null })).toBe(false)
    expect(canRestoreVersion(employeeActor, { ownerId: undefined as any })).toBe(false)
  })
})
