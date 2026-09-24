import { describe, it, expect } from "vitest"
import {
  ACTIVITY_KINDS,
  ActivityValidationError,
  allowedKindsFor,
  buildActivityEvent,
  canViewActivity,
  clampLimit,
  compareActivityDesc,
  decodeCursor,
  encodeCursor,
  filterVisibleActivities,
  isActivityKind,
  maxVisibilityRankFor,
  paginateTimeline,
  sortTimeline,
  toTimestamp,
  validateActivity,
  visibilityRank,
  type ActivityEvent,
  type ActivityViewer,
} from "@/lib/activity/model"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ev(partial: Partial<ActivityEvent>): ActivityEvent {
  return {
    kind: "note",
    subject_type: "contact",
    subject_id: "1",
    subject_label: null,
    action: null,
    title: "x",
    body: null,
    source_module: null,
    actor_id: null,
    actor_type: "user",
    ref_type: null,
    ref_id: null,
    occurred_at: "2026-01-01 00:00:00.000",
    visibility: "timeline",
    importance: 0,
    watchers: [],
    meta: null,
    ...partial,
  }
}

const admin: ActivityViewer = { userId: 1, role: "admin" }
const staff: ActivityViewer = { userId: 2, role: "employee", features: [] }
const portal: ActivityViewer = { userId: 3, role: "employee", isPortal: true, features: [] }
const finance: ActivityViewer = { userId: 4, role: "employee", features: ["finance.view_payments"] }

// ---------------------------------------------------------------------------
// Taxonomy + validation
// ---------------------------------------------------------------------------

describe("taxonomy", () => {
  it("covers the ten spec kinds", () => {
    expect([...ACTIVITY_KINDS]).toEqual([
      "call",
      "email",
      "meeting",
      "note",
      "task",
      "status_change",
      "approval",
      "payment",
      "document",
      "system",
    ])
  })

  it("isActivityKind guards unknown values", () => {
    expect(isActivityKind("payment")).toBe(true)
    expect(isActivityKind("gossip")).toBe(false)
    expect(isActivityKind(null)).toBe(false)
  })
})

describe("validateActivity", () => {
  it("requires a known kind, subject and a title or action", () => {
    expect(validateActivity({ kind: "note", subject_type: "contact", subject_id: 1, title: "Hi" })).toEqual({})
    const e = validateActivity({ kind: "bogus", subject_type: "", subject_id: "", title: "" } as any)
    expect(e.kind).toBeTruthy()
    expect(e.subject_type).toBeTruthy()
    expect(e.subject_id).toBeTruthy()
    expect(e.title).toBeTruthy()
  })

  it("accepts an action instead of a title", () => {
    expect(validateActivity({ kind: "call", subject_type: "lead", subject_id: 9, action: "called" })).toEqual({})
  })

  it("rejects non-object meta", () => {
    expect(validateActivity({ kind: "note", subject_type: "c", subject_id: 1, title: "t", meta: [1, 2] as any }).meta).toBeTruthy()
  })
})

describe("buildActivityEvent", () => {
  it("normalizes and derives a title when only an action is given", () => {
    const e = buildActivityEvent({
      kind: "status_change",
      subject_type: "lead",
      subject_id: 42,
      subject_label: "Acme deal",
      action: "Won",
    })
    expect(e.subject_id).toBe("42")
    expect(e.title).toBe("Acme deal: Won")
    expect(e.visibility).toBe("timeline")
    expect(e.actor_type).toBe("user")
  })

  it("throws ActivityValidationError with a field map on bad input", () => {
    expect(() => buildActivityEvent({ kind: "nope", subject_type: "", subject_id: "", title: "" } as any)).toThrow(
      ActivityValidationError,
    )
    try {
      buildActivityEvent({ kind: "nope" } as any)
    } catch (err) {
      expect(err).toBeInstanceOf(ActivityValidationError)
      expect((err as ActivityValidationError).fields.kind).toBeTruthy()
    }
  })

  it("clamps importance and dedupes watchers", () => {
    const e = buildActivityEvent({
      kind: "note",
      subject_type: "c",
      subject_id: 1,
      title: "t",
      importance: 99,
      watchers: [5, 5, 6, "7", 0, -1] as any,
    })
    expect(e.importance).toBe(3)
    expect(e.watchers).toEqual([5, 6, 7])
  })

  it("drops unserializable meta rather than throwing at build for objects", () => {
    const cyclic: any = {}
    cyclic.self = cyclic
    // validate flags it; build throws through validation
    expect(() => buildActivityEvent({ kind: "note", subject_type: "c", subject_id: 1, title: "t", meta: cyclic })).toThrow(
      ActivityValidationError,
    )
  })
})

describe("toTimestamp", () => {
  it("formats dates to sortable UTC strings and falls back to now", () => {
    expect(toTimestamp(new Date("2026-03-04T05:06:07.008Z"))).toBe("2026-03-04 05:06:07.008")
    const now = new Date("2026-09-24T10:00:00.000Z")
    expect(toTimestamp("not-a-date", now)).toBe("2026-09-24 10:00:00.000")
    expect(toTimestamp(null, now)).toBe("2026-09-24 10:00:00.000")
  })
})

// ---------------------------------------------------------------------------
// Ordering (Phase 4)
// ---------------------------------------------------------------------------

describe("ordering", () => {
  it("sorts newest-first with id as a stable tie-break", () => {
    const events = [
      ev({ id: 1, occurred_at: "2026-01-01 10:00:00.000" }),
      ev({ id: 2, occurred_at: "2026-01-01 10:00:00.000" }),
      ev({ id: 3, occurred_at: "2026-01-02 09:00:00.000" }),
      ev({ id: 4, occurred_at: "2026-01-01 08:00:00.000" }),
    ]
    const sorted = sortTimeline(events)
    expect(sorted.map((e) => e.id)).toEqual([3, 2, 1, 4])
  })

  it("compareActivityDesc is a total order (antisymmetric)", () => {
    const a = ev({ id: 10, occurred_at: "2026-01-01 00:00:00.000" })
    const b = ev({ id: 11, occurred_at: "2026-01-01 00:00:00.000" })
    expect(compareActivityDesc(a, b)).toBe(1) // b newer (higher id) -> a after b
    expect(compareActivityDesc(b, a)).toBe(-1)
    expect(compareActivityDesc(a, a)).toBe(0)
  })

  it("does not mutate the input array", () => {
    const events = [ev({ id: 1 }), ev({ id: 2, occurred_at: "2027-01-01 00:00:00.000" })]
    const copy = [...events]
    sortTimeline(events)
    expect(events).toEqual(copy)
  })
})

// ---------------------------------------------------------------------------
// Keyset pagination + performance (Phase 4)
// ---------------------------------------------------------------------------

describe("cursor codec", () => {
  it("round-trips a cursor", () => {
    const token = encodeCursor({ occurredAt: "2026-01-01 10:00:00.000", id: 55 })
    expect(decodeCursor(token)).toEqual({ occurredAt: "2026-01-01 10:00:00.000", id: 55 })
  })
  it("rejects garbage cursors", () => {
    expect(decodeCursor("")).toBeNull()
    expect(decodeCursor("!!!notbase64!!!")).toBeNull()
    expect(decodeCursor(Buffer.from('{"a":1}').toString("base64url"))).toBeNull()
  })
})

describe("clampLimit", () => {
  it("bounds the page size", () => {
    expect(clampLimit(0)).toBe(25)
    expect(clampLimit(-5)).toBe(25)
    expect(clampLimit(10)).toBe(10)
    expect(clampLimit(9999)).toBe(100)
    expect(clampLimit("abc")).toBe(25)
  })
})

describe("paginateTimeline", () => {
  // Build 250 events across 50 timestamps (5 per timestamp) to force id tie-breaks.
  const all = sortTimeline(
    Array.from({ length: 250 }, (_, i) =>
      ev({
        id: i + 1,
        occurred_at: `2026-01-${String(1 + Math.floor(i / 5)).padStart(2, "0")} 00:00:00.000`,
      }),
    ),
  )

  it("walks every row exactly once with no gaps or duplicates", () => {
    const seen: number[] = []
    let cursor = null as null | { occurredAt: string; id: number }
    let pages = 0
    while (true) {
      const { page, nextCursor } = paginateTimeline(all, 25, cursor)
      seen.push(...page.map((e) => e.id!))
      pages++
      if (!nextCursor) break
      cursor = decodeCursor(nextCursor)
      expect(cursor).not.toBeNull()
      expect(pages).toBeLessThan(20) // guards against an infinite loop
    }
    expect(pages).toBe(10)
    expect(seen.length).toBe(250)
    expect(new Set(seen).size).toBe(250)
    // Order is preserved across page boundaries.
    expect(seen).toEqual(all.map((e) => e.id))
  })

  it("returns a null nextCursor on the final page", () => {
    const { page, nextCursor } = paginateTimeline(all.slice(0, 20), 25)
    expect(page.length).toBe(20)
    expect(nextCursor).toBeNull()
  })

  it("is stable when rows share a timestamp (tie-break by id)", () => {
    const tied = sortTimeline(
      Array.from({ length: 8 }, (_, i) => ev({ id: i + 1, occurred_at: "2026-05-05 12:00:00.000" })),
    )
    const first = paginateTimeline(tied, 3)
    expect(first.page.map((e) => e.id)).toEqual([8, 7, 6])
    const second = paginateTimeline(tied, 3, decodeCursor(first.nextCursor!))
    expect(second.page.map((e) => e.id)).toEqual([5, 4, 3])
    const third = paginateTimeline(tied, 3, decodeCursor(second.nextCursor!))
    expect(third.page.map((e) => e.id)).toEqual([2, 1])
    expect(third.nextCursor).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Permissions (Phase 4)
// ---------------------------------------------------------------------------

describe("canViewActivity", () => {
  it("admins see everything, including private events of other users", () => {
    expect(canViewActivity(ev({ visibility: "private", actor_id: 99 }), admin)).toBe(true)
    expect(canViewActivity(ev({ kind: "payment" }), admin)).toBe(true)
  })

  it("private events are visible only to the actor or a named watcher", () => {
    const owned = ev({ visibility: "private", actor_id: 2 })
    const watched = ev({ visibility: "private", actor_id: 99, watchers: [2] })
    const foreign = ev({ visibility: "private", actor_id: 99, watchers: [7] })
    expect(canViewActivity(owned, staff)).toBe(true)
    expect(canViewActivity(watched, staff)).toBe(true)
    expect(canViewActivity(foreign, staff)).toBe(false)
  })

  it("internal events are hidden from portal viewers but shown to staff", () => {
    const internal = ev({ visibility: "internal" })
    expect(canViewActivity(internal, staff)).toBe(true)
    expect(canViewActivity(internal, portal)).toBe(false)
  })

  it("sensitive kinds require their module feature", () => {
    const payment = ev({ kind: "payment" })
    const approval = ev({ kind: "approval" })
    expect(canViewActivity(payment, staff)).toBe(false)
    expect(canViewActivity(payment, finance)).toBe(true)
    expect(canViewActivity(approval, staff)).toBe(false)
  })

  it("filterVisibleActivities drops everything a viewer cannot see", () => {
    const events = [
      ev({ id: 1, kind: "note" }),
      ev({ id: 2, kind: "payment" }),
      ev({ id: 3, visibility: "private", actor_id: 99 }),
      ev({ id: 4, visibility: "internal" }),
    ]
    expect(filterVisibleActivities(events, staff).map((e) => e.id)).toEqual([1, 4])
    expect(filterVisibleActivities(events, portal).map((e) => e.id)).toEqual([1])
    expect(filterVisibleActivities(events, admin).map((e) => e.id)).toEqual([1, 2, 3, 4])
  })
})

describe("DB pre-filter helpers agree with canViewActivity", () => {
  it("allowedKindsFor excludes gated kinds for unprivileged viewers", () => {
    expect(allowedKindsFor(admin)).toEqual([...ACTIVITY_KINDS])
    expect(allowedKindsFor(staff)).not.toContain("payment")
    expect(allowedKindsFor(staff)).not.toContain("approval")
    expect(allowedKindsFor(finance)).toContain("payment")
    expect(allowedKindsFor(finance)).not.toContain("approval")
  })

  it("maxVisibilityRankFor matches the visibility ladder", () => {
    expect(maxVisibilityRankFor(admin)).toBe(visibilityRank("private"))
    expect(maxVisibilityRankFor(staff)).toBe(visibilityRank("internal"))
    expect(maxVisibilityRankFor(portal)).toBe(visibilityRank("timeline"))
  })

  it("every kind the DB pre-filter admits also passes the pure predicate (defense in depth)", () => {
    for (const viewer of [admin, staff, portal, finance]) {
      const kinds = allowedKindsFor(viewer)
      for (const kind of kinds) {
        // a timeline-visibility event of an allowed kind must be viewable
        expect(canViewActivity(ev({ kind, visibility: "timeline" }), viewer)).toBe(true)
      }
    }
  })
})
