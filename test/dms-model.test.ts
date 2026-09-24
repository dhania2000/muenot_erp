import { describe, expect, it } from "vitest"
import {
  type AccessContext,
  type AccessGrant,
  accessAtLeast,
  ancestorIdsFromMap,
  canPerform,
  evaluateShareAccess,
  formatDocRef,
  generateShareToken,
  isExpired,
  normalizeAccessLevel,
  normalizeApproval,
  normalizeRecipientType,
  normalizeShareAccess,
  normalizeStatus,
  normalizeSubjectType,
  resolveEffectiveAccess,
  shareDownloadExhausted,
  shareTokenValid,
  type ShareGate,
} from "@/lib/dms/model"

/**
 * SPEC 86 — Phase 4 verification for the DMS pure model layer: permission
 * resolution, folder-inheritance ancestry, expiry, and share-token validity.
 * These are the deterministic guarantees the store + routes rely on.
 */

function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    userId: overrides.userId ?? 7,
    role: overrides.role ?? "employee",
    isAdmin: overrides.isAdmin ?? false,
    isOwner: overrides.isOwner ?? false,
    grants: overrides.grants ?? [],
  }
}

function grant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    subjectType: overrides.subjectType ?? "user",
    subjectId: overrides.subjectId ?? "7",
    accessLevel: overrides.accessLevel ?? "view",
  }
}

describe("normalizers reject untrusted input", () => {
  it("falls back to safe defaults", () => {
    expect(normalizeStatus("bogus")).toBe("draft")
    expect(normalizeStatus("ARCHIVED")).toBe("archived")
    expect(normalizeApproval(undefined)).toBe("none")
    expect(normalizeApproval("Approved")).toBe("approved")
    expect(normalizeAccessLevel("god")).toBe("view")
    expect(normalizeAccessLevel("MANAGE")).toBe("manage")
    expect(normalizeSubjectType("anything")).toBe("user")
    expect(normalizeSubjectType("role")).toBe("role")
    expect(normalizeShareAccess("edit")).toBe("view")
    expect(normalizeShareAccess("download")).toBe("download")
  })
})

describe("formatDocRef", () => {
  it("zero-pads to a stable reference", () => {
    expect(formatDocRef(42)).toBe("DOC-000042")
    expect(formatDocRef(1_000_000)).toBe("DOC-1000000")
  })
})

describe("resolveEffectiveAccess — permissions", () => {
  it("grants manage to admins and owners regardless of explicit grants", () => {
    expect(resolveEffectiveAccess(ctx({ isAdmin: true }))).toBe("manage")
    expect(resolveEffectiveAccess(ctx({ isOwner: true }))).toBe("manage")
  })

  it("returns null when no grant matches the subject", () => {
    expect(resolveEffectiveAccess(ctx({ grants: [grant({ subjectId: "999" })] }))).toBeNull()
    expect(resolveEffectiveAccess(ctx())).toBeNull()
  })

  it("matches a user grant by id", () => {
    expect(
      resolveEffectiveAccess(ctx({ userId: 7, grants: [grant({ subjectId: "7", accessLevel: "edit" })] })),
    ).toBe("edit")
  })

  it("matches a role grant case-insensitively", () => {
    expect(
      resolveEffectiveAccess(
        ctx({
          role: "Manager",
          grants: [grant({ subjectType: "role", subjectId: "manager", accessLevel: "download" })],
        }),
      ),
    ).toBe("download")
  })

  it("takes the strongest of several matching grants", () => {
    const access = resolveEffectiveAccess(
      ctx({
        userId: 7,
        role: "manager",
        grants: [
          grant({ subjectId: "7", accessLevel: "view" }),
          grant({ subjectType: "role", subjectId: "manager", accessLevel: "edit" }),
          grant({ subjectId: "7", accessLevel: "download" }),
        ],
      }),
    )
    expect(access).toBe("edit")
  })
})

describe("access level comparisons drive action gating", () => {
  it("accessAtLeast ranks levels correctly", () => {
    expect(accessAtLeast("manage", "edit")).toBe(true)
    expect(accessAtLeast("view", "download")).toBe(false)
    expect(accessAtLeast(null, "view")).toBe(false)
  })

  it("canPerform maps actions to the required level", () => {
    expect(canPerform("view", "view")).toBe(true)
    expect(canPerform("download", "view")).toBe(false)
    expect(canPerform("edit", "download")).toBe(false)
    expect(canPerform("share", "edit")).toBe(true)
    expect(canPerform("delete", "edit")).toBe(false)
    expect(canPerform("delete", "manage")).toBe(true)
    expect(canPerform("manage_permissions", "edit")).toBe(false)
    expect(canPerform("approve", "manage")).toBe(true)
    expect(canPerform("view", null)).toBe(false)
  })
})

describe("ancestorIdsFromMap — folder permission inheritance", () => {
  const parents = new Map<number, number | null>([
    [1, null],
    [2, 1],
    [3, 2],
  ])

  it("returns the folder plus every ancestor, deepest first", () => {
    expect(ancestorIdsFromMap(3, parents)).toEqual([3, 2, 1])
    expect(ancestorIdsFromMap(1, parents)).toEqual([1])
  })

  it("returns empty for a null folder (document at root)", () => {
    expect(ancestorIdsFromMap(null, parents)).toEqual([])
  })

  it("is cycle-safe if the parent map is corrupt", () => {
    const cyclic = new Map<number, number | null>([
      [1, 2],
      [2, 1],
    ])
    expect(ancestorIdsFromMap(1, cyclic)).toEqual([1, 2])
  })
})

describe("isExpired — expiry / retention", () => {
  const now = new Date("2026-06-01T00:00:00Z")

  it("treats null / undefined as never expiring", () => {
    expect(isExpired(null, now)).toBe(false)
    expect(isExpired(undefined, now)).toBe(false)
  })

  it("detects a passed expiry and honors a future one", () => {
    expect(isExpired("2026-05-31 23:59:59", now)).toBe(true)
    expect(isExpired("2026-06-02T00:00:00Z", now)).toBe(false)
  })

  it("ignores unparseable dates", () => {
    expect(isExpired("not-a-date", now)).toBe(false)
  })
})

describe("share tokens — sharing", () => {
  it("generates unguessable, URL-safe, unique tokens", () => {
    const a = generateShareToken()
    const b = generateShareToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(24)
  })

  it("is valid only when neither revoked nor expired", () => {
    const now = new Date("2026-06-01T00:00:00Z")
    expect(shareTokenValid({ expiresAt: null, revokedAt: null }, now)).toBe(true)
    expect(shareTokenValid({ expiresAt: "2026-12-31T00:00:00Z", revokedAt: null }, now)).toBe(true)
    expect(shareTokenValid({ expiresAt: "2026-01-01T00:00:00Z", revokedAt: null }, now)).toBe(false)
    expect(shareTokenValid({ expiresAt: null, revokedAt: "2026-05-01T00:00:00Z" }, now)).toBe(false)
  })
})

/**
 * SPEC 89 — Phase 4 verification for the pure access gate. These cover the
 * unauthorized and expired-link paths the signed route and public landing page
 * both rely on, in the exact severity order the gate resolves them.
 */
describe("evaluateShareAccess — signed access gate", () => {
  const now = new Date("2026-06-01T00:00:00Z")

  function gate(overrides: Partial<ShareGate> = {}): ShareGate {
    return {
      access: overrides.access ?? "download",
      expiresAt: overrides.expiresAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
      recipientType: overrides.recipientType ?? "link",
      recipient: overrides.recipient ?? null,
      hasPassword: overrides.hasPassword ?? false,
      maxDownloads: overrides.maxDownloads ?? null,
      downloadCount: overrides.downloadCount ?? 0,
    }
  }

  it("allows an open, unexpired link to be viewed and downloaded", () => {
    expect(evaluateShareAccess({ share: gate(), intent: "view", now })).toEqual({ ok: true })
    expect(evaluateShareAccess({ share: gate(), intent: "download", now })).toEqual({ ok: true })
  })

  it("blocks a revoked link before anything else", () => {
    const share = gate({ revokedAt: "2026-05-01T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z" })
    expect(evaluateShareAccess({ share, intent: "view", now })).toEqual({ ok: false, reason: "revoked" })
  })

  it("blocks an expired link", () => {
    const share = gate({ expiresAt: "2026-01-01T00:00:00Z" })
    expect(evaluateShareAccess({ share, intent: "view", now })).toEqual({ ok: false, reason: "expired" })
    // A future expiry is still valid.
    const future = gate({ expiresAt: "2026-12-31T00:00:00Z" })
    expect(evaluateShareAccess({ share: future, intent: "view", now })).toEqual({ ok: true })
  })

  it("requires a signed-in viewer for internal and team links", () => {
    const internal = gate({ recipientType: "internal", recipient: "42" })
    expect(evaluateShareAccess({ share: internal, intent: "view", now })).toEqual({
      ok: false,
      reason: "login_required",
    })
    const team = gate({ recipientType: "team", recipient: "admin" })
    expect(evaluateShareAccess({ share: team, intent: "view", now })).toEqual({
      ok: false,
      reason: "login_required",
    })
  })

  it("rejects an internal link when the viewer is not the named user", () => {
    const share = gate({ recipientType: "internal", recipient: "42" })
    expect(
      evaluateShareAccess({ share, intent: "view", viewer: { userId: 7, role: "employee" }, now }),
    ).toEqual({ ok: false, reason: "forbidden" })
    expect(
      evaluateShareAccess({ share, intent: "view", viewer: { userId: 42, role: "employee" }, now }),
    ).toEqual({ ok: true })
  })

  it("rejects a team link when the viewer's role does not match", () => {
    const share = gate({ recipientType: "team", recipient: "admin" })
    expect(
      evaluateShareAccess({ share, intent: "view", viewer: { userId: 7, role: "employee" }, now }),
    ).toEqual({ ok: false, reason: "forbidden" })
    // Role match is case-insensitive.
    expect(
      evaluateShareAccess({ share, intent: "view", viewer: { userId: 7, role: "ADMIN" }, now }),
    ).toEqual({ ok: true })
  })

  it("requires a verified password when one is set", () => {
    const share = gate({ hasPassword: true })
    expect(evaluateShareAccess({ share, intent: "view", now })).toEqual({
      ok: false,
      reason: "password_required",
    })
    expect(evaluateShareAccess({ share, intent: "view", passwordVerified: true, now })).toEqual({ ok: true })
  })

  it("enforces view-only links and download caps", () => {
    const viewOnly = gate({ access: "view" })
    expect(evaluateShareAccess({ share: viewOnly, intent: "view", now })).toEqual({ ok: true })
    expect(evaluateShareAccess({ share: viewOnly, intent: "download", now })).toEqual({
      ok: false,
      reason: "download_disabled",
    })

    const capped = gate({ maxDownloads: 2, downloadCount: 2 })
    expect(evaluateShareAccess({ share: capped, intent: "download", now })).toEqual({
      ok: false,
      reason: "download_limit",
    })
    expect(shareDownloadExhausted(capped)).toBe(true)
    // Viewing is still allowed even when the download cap is reached.
    expect(evaluateShareAccess({ share: capped, intent: "view", now })).toEqual({ ok: true })
  })

  it("normalizes unknown recipient types to an open link", () => {
    expect(normalizeRecipientType("nonsense")).toBe("link")
    expect(normalizeRecipientType("internal")).toBe("internal")
  })
})
