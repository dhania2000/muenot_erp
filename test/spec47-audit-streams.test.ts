import { describe, expect, it } from "vitest"

/**
 * Spec47 (#38-40, #209-212, #245-249) — security review & separated audit streams.
 *
 * The subsystem is DB-free at its core (lib/audit-streams-model.ts): stream
 * classification, viewer visibility, cross-tenant SQL scoping, field masking,
 * retention + legal hold, integrity/tamper verification, export idempotency,
 * append-only protection, reviewer segregation-of-duties and impersonation
 * window rules. These tests exercise those rules directly.
 */

import {
  APPEND_ONLY_TABLES,
  assertMutableTable,
  buildAuditLogStreamWhere,
  canExportUnmasked,
  canReadStream,
  checkCampaignReviewer,
  checkDecisionConflict,
  classifyAuditRow,
  computeAuditIntegrityHash,
  computeExportDigest,
  computeImpersonationExpiry,
  isAppendOnlyTable,
  isAuditStream,
  isImpersonationWindowOpen,
  isValidIdempotencyKey,
  maskEmail,
  maskIp,
  maskStreamRecord,
  parseExportRequest,
  resolveImpersonationMinutes,
  StreamAccessError,
  type StreamRecord,
  type StreamViewer,
  validateImpersonationReason,
  verifyAuditRowIntegrity,
} from "@/lib/audit-streams-model"
import { applyExportRetention } from "@/lib/audit-streams-model"

const tenantViewer: StreamViewer = { kind: "tenant_admin", tenantId: 200, isOwner: false }
const tenantOwner: StreamViewer = { kind: "tenant_admin", tenantId: 200, isOwner: true }
const staff: StreamViewer = { kind: "platform_staff" }
const superAdmin: StreamViewer = { kind: "platform_super_admin" }

function record(overrides: Partial<StreamRecord> = {}): StreamRecord {
  return {
    source: "audit_log",
    sourceId: 1,
    stream: "security",
    tenantId: 200,
    occurredAt: new Date().toISOString(),
    actorUserId: 5,
    actorName: "Alice Admin",
    actorEmail: "alice@example.com",
    subject: "bob@example.com",
    action: "role.assign",
    outcome: "success",
    entityType: "role",
    entityId: "9",
    ipAddress: "192.168.4.7",
    userAgent: "Mozilla/5.0 (X11)",
    detail: null,
    integrity: "verified",
    ...overrides,
  }
}

describe("stream classification & separation", () => {
  it("routes rows into exactly one stream by precedence", () => {
    expect(classifyAuditRow("security_event", "anything", 200)).toBe("security")
    expect(classifyAuditRow("audit_log", "impersonation.start", 200)).toBe("security")
    expect(classifyAuditRow("audit_log", "billing.invoice_paid", 200)).toBe("billing")
    expect(classifyAuditRow("audit_log", "support.ticket_open", 200)).toBe("support")
    expect(classifyAuditRow("audit_log", "inventory.update", 200)).toBe("tenant")
    // NULL-tenant business row is a platform-stream row, never a tenant row.
    expect(classifyAuditRow("audit_log", "inventory.update", null)).toBe("platform")
    // Operator actions split: privileged-access ones are security, the rest platform.
    expect(classifyAuditRow("platform_admin", "impersonation_start", 200)).toBe("security")
    expect(classifyAuditRow("platform_admin", "tenant_suspend", 200)).toBe("platform")
  })

  it("guards the stream enum", () => {
    expect(isAuditStream("security")).toBe(true)
    expect(isAuditStream("nope")).toBe(false)
  })
})

describe("viewer visibility (who reads which projection)", () => {
  it("tenant admins read their own non-platform streams only", () => {
    expect(canReadStream(tenantViewer, "tenant")).toBe(true)
    expect(canReadStream(tenantViewer, "billing")).toBe(true)
    expect(canReadStream(tenantViewer, "security")).toBe(true)
    expect(canReadStream(tenantViewer, "platform")).toBe(false)
  })

  it("platform staff read platform/billing/support but never the security or tenant streams", () => {
    expect(canReadStream(staff, "platform")).toBe(true)
    expect(canReadStream(staff, "billing")).toBe(true)
    expect(canReadStream(staff, "support")).toBe(true)
    expect(canReadStream(staff, "security")).toBe(false)
    expect(canReadStream(staff, "tenant")).toBe(false)
  })

  it("only a super admin reads the cross-tenant security stream, never the tenant stream", () => {
    expect(canReadStream(superAdmin, "security")).toBe(true)
    expect(canReadStream(superAdmin, "platform")).toBe(true)
    expect(canReadStream(superAdmin, "tenant")).toBe(false)
  })

  it("unmasked export is reserved for tenant owner / super admin", () => {
    expect(canExportUnmasked(tenantOwner)).toBe(true)
    expect(canExportUnmasked(superAdmin)).toBe(true)
    expect(canExportUnmasked(tenantViewer)).toBe(false)
    expect(canExportUnmasked(staff)).toBe(false)
  })
})

describe("cross-tenant SQL scoping", () => {
  it("always pins a tenant viewer to its own tenant_id", () => {
    const where = buildAuditLogStreamWhere("security", tenantViewer)
    expect(where.sql).toContain("`tenant_id` = ?")
    expect(where.params[0]).toBe(200)
  })

  it("ignores a platform viewer's tenant filter unless explicitly narrowed", () => {
    const platformWide = buildAuditLogStreamWhere("platform", superAdmin)
    expect(platformWide.sql).toContain("`tenant_id` IS NULL")
    const narrowed = buildAuditLogStreamWhere("billing", staff, 321)
    expect(narrowed.params).toContain(321)
  })

  it("refuses to build a WHERE for a stream the viewer cannot read", () => {
    expect(() => buildAuditLogStreamWhere("platform", tenantViewer)).toThrow(StreamAccessError)
    expect(() => buildAuditLogStreamWhere("security", staff)).toThrow(StreamAccessError)
  })

  it("excludes higher-precedence actions from lower streams", () => {
    const billing = buildAuditLogStreamWhere("billing", superAdmin, 200)
    // billing must NOT include security-prefixed rows
    expect(billing.sql).toContain("NOT (")
  })
})

describe("field masking, retention & legal holds (exports)", () => {
  it("masks PII when masked, preserves it when unmasked", () => {
    const masked = maskStreamRecord(record(), true)
    expect(masked.actorEmail).toBe("a***@example.com")
    expect(masked.ipAddress).toBe("192.168.x.x")
    expect(masked.actorName).toBe("A. A.")

    const unmasked = maskStreamRecord(record(), false)
    expect(unmasked.actorEmail).toBe("alice@example.com")
    expect(unmasked.ipAddress).toBe("192.168.4.7")
  })

  it("always redacts secret-valued keys, even unmasked", () => {
    const rec = record({ detail: { password: "hunter2", note: "ok", token: "abc" } })
    const unmasked = maskStreamRecord(rec, false)
    expect(unmasked.detail?.password).toBe("[REDACTED]")
    expect(unmasked.detail?.token).toBe("[REDACTED]")
    expect(unmasked.detail?.note).toBe("ok")
  })

  it("maskEmail/maskIp handle edge inputs", () => {
    expect(maskEmail(null)).toBeNull()
    expect(maskEmail("no-at-sign")).toBe("***")
    expect(maskIp("2001:db8::1")).toBe("2001:db8::*")
  })

  it("drops records beyond retention unless a legal hold covers them", () => {
    const old = record({ sourceId: 1, occurredAt: "2000-01-01T00:00:00.000Z", action: "role.assign", entityType: "role", actorUserId: 5 })
    const fresh = record({ sourceId: 2, occurredAt: new Date().toISOString(), action: "inventory.update", entityType: "product" })
    const noHold = applyExportRetention([old, fresh], { retentionDays: 30, holds: [] })
    expect(noHold.kept).toHaveLength(1)
    expect(noHold.excludedByRetention).toBe(1)

    const held = applyExportRetention([old, fresh], {
      retentionDays: 30,
      holds: [{ action: "role.assign" } as any],
    })
    expect(held.kept).toHaveLength(2)
    expect(held.heldCount).toBe(1)
    expect(held.kept.find((r) => r.sourceId === 1)?.legalHold).toBe(true)
  })
})

describe("tamper evidence (integrity)", () => {
  const hashable = {
    requestId: "req-1",
    tenantId: 200,
    actorUserId: 5,
    sessionId: "sess-1",
    ipAddress: "10.0.0.1",
    action: "role.assign",
    entityType: "role",
    entityId: "9",
    result: "success",
    before: { role: "employee" },
    after: { role: "tenant_admin" },
  }

  it("verifies an untampered row and flags an edited one", () => {
    const integrityHash = computeAuditIntegrityHash(hashable)
    expect(verifyAuditRowIntegrity({ ...hashable, integrityHash })).toBe("verified")
    // A silent edit of a signed top-level field (e.g. flipping the outcome or
    // the entity it targeted) breaks the hash and is flagged as tamper.
    expect(verifyAuditRowIntegrity({ ...hashable, result: "failure", integrityHash })).toBe("mismatch")
    expect(verifyAuditRowIntegrity({ ...hashable, entityId: "42", integrityHash })).toBe("mismatch")
  })

  it("treats a missing hash as unsigned, not verified", () => {
    expect(verifyAuditRowIntegrity({ ...hashable, integrityHash: null })).toBe("unsigned")
  })

  it("export digest is order-sensitive and edit-sensitive", () => {
    const a = record({ sourceId: 1 })
    const b = record({ sourceId: 2 })
    const d1 = computeExportDigest([a, b])
    const d2 = computeExportDigest([b, a])
    const d3 = computeExportDigest([a, { ...b, action: "role.revoke" }])
    expect(d1).not.toBe(d2)
    expect(d1).not.toBe(d3)
    expect(computeExportDigest([a, b])).toBe(d1) // deterministic
  })
})

describe("append-only protection", () => {
  it("lists the evidence tables and blocks generic mutation", () => {
    for (const t of APPEND_ONLY_TABLES) {
      expect(isAppendOnlyTable(t)).toBe(true)
      expect(() => assertMutableTable(t)).toThrow(StreamAccessError)
    }
    expect(isAppendOnlyTable("`audit_log_entries`")).toBe(true)
    expect(isAppendOnlyTable("products")).toBe(false)
    expect(() => assertMutableTable("products")).not.toThrow()
  })

  it("the append-only guard uses HTTP 405", () => {
    try {
      assertMutableTable("security_audit_events")
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as StreamAccessError).status).toBe(405)
    }
  })
})

describe("export request validation & idempotency", () => {
  it("requires a valid stream, a justification, and rejects unmasked without privilege", () => {
    expect(() => parseExportRequest({ stream: "nope", reason: "x".repeat(20) }, tenantOwner)).toThrow(StreamAccessError)
    expect(() => parseExportRequest({ stream: "security", reason: "too short" }, tenantOwner)).toThrow(StreamAccessError)
    expect(() =>
      parseExportRequest({ stream: "security", masked: false, reason: "valid reason here" }, tenantViewer),
    ).toThrow(/Unmasked export/)
  })

  it("pins a tenant viewer's export to its own tenant and ignores a supplied tenantId", () => {
    const req = parseExportRequest({ stream: "security", reason: "quarterly access review", tenantId: 999 }, tenantOwner)
    expect(req.tenantId).toBe(200)
    expect(req.masked).toBe(true)
  })

  it("lets a platform viewer narrow to a tenant", () => {
    const req = parseExportRequest({ stream: "billing", reason: "billing dispute review", tenantId: 321 }, staff)
    expect(req.tenantId).toBe(321)
  })

  it("validates idempotency keys", () => {
    expect(isValidIdempotencyKey("a1b2c3d4")).toBe(true)
    expect(isValidIdempotencyKey("short")).toBe(false)
    expect(isValidIdempotencyKey("has space!")).toBe(false)
    expect(isValidIdempotencyKey(123)).toBe(false)
  })
})

describe("reviewer segregation of duties", () => {
  it("blocks a reviewer who is a subject or not in the tenant", () => {
    expect(checkCampaignReviewer({ reviewerId: 5, reviewerActiveInTenant: false, subjectIds: [1, 2] })).toBe(
      "reviewer_not_in_tenant",
    )
    expect(checkCampaignReviewer({ reviewerId: 5, reviewerActiveInTenant: true, subjectIds: [1, 5, 2] })).toBe(
      "reviewer_is_subject",
    )
    expect(checkCampaignReviewer({ reviewerId: 5, reviewerActiveInTenant: true, subjectIds: [1, 2] })).toBeNull()
  })

  it("blocks self-review, wrong reviewer and closed campaigns at decision time", () => {
    expect(checkDecisionConflict({ actorUserId: 5, reviewerId: 5, subjectId: 5, campaignStatus: "open" })).toBe(
      "self_review",
    )
    expect(checkDecisionConflict({ actorUserId: 7, reviewerId: 5, subjectId: 3, campaignStatus: "open" })).toBe(
      "not_assigned_reviewer",
    )
    expect(checkDecisionConflict({ actorUserId: 5, reviewerId: 5, subjectId: 3, campaignStatus: "closed" })).toBe(
      "campaign_closed",
    )
    expect(checkDecisionConflict({ actorUserId: 5, reviewerId: 5, subjectId: 3, campaignStatus: "open" })).toBeNull()
    expect(checkDecisionConflict({ actorUserId: 5, reviewerId: 5, subjectId: 3, campaignStatus: "overdue" })).toBeNull()
  })
})

describe("impersonation / break-glass window", () => {
  it("clamps the requested minutes into the allowed band", () => {
    expect(resolveImpersonationMinutes(1)).toBe(5) // below min
    expect(resolveImpersonationMinutes(9999)).toBe(120) // above max
    expect(resolveImpersonationMinutes(45)).toBe(45)
    expect(resolveImpersonationMinutes(undefined)).toBe(30) // default
  })

  it("honors an open window and fails closed once expired or unsigned", () => {
    const now = 1_000_000_000_000
    const expiry = computeImpersonationExpiry(now, 30)
    expect(isImpersonationWindowOpen(expiry, now)).toBe(true)
    expect(isImpersonationWindowOpen(expiry, expiry + 1)).toBe(false) // expired
    expect(isImpersonationWindowOpen(null, now)).toBe(false) // forged/legacy fails closed
    expect(isImpersonationWindowOpen("soon", now)).toBe(false)
  })

  it("requires a substantive break-glass reason", () => {
    expect(validateImpersonationReason("short")).toBeNull()
    expect(validateImpersonationReason("  legitimate incident #4821 investigation  ")).toBe(
      "legitimate incident #4821 investigation",
    )
  })
})
