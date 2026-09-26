import { describe, expect, it } from "vitest"
import {
  CollabError,
  crmDedupeKey,
  displayUser,
  getSubject,
  openLink,
  parseMentions,
  parseSubjectId,
  redactActivityMeta,
  renderMentions,
  sortInbox,
  validateComment,
  validateCrmEvent,
  type InboxItem,
} from "@/lib/collaboration/model"
import { TENANT_OWNED_TABLES } from "@/lib/tenant-tables"

describe("subjects & ids", () => {
  it("only resolves registered subject types (no prototype keys)", () => {
    expect(getSubject("lead")?.table).toBe("sales_leads")
    expect(getSubject("constructor")).toBeNull()
    expect(getSubject("__proto__")).toBeNull()
    expect(getSubject(42)).toBeNull()
  })
  it("rejects non-positive / non-integer ids", () => {
    expect(parseSubjectId("7")).toBe(7)
    for (const bad of ["0", "-1", "1.5", "abc", "", null, "1; DROP TABLE"]) expect(() => parseSubjectId(bad)).toThrow(CollabError)
  })
  it("deep links go through the access-rechecking open route", () => {
    expect(openLink("lead", 5, 9)).toBe("/api/collaboration/open/lead/5?comment=9")
  })
  it("registers all collaboration tables as tenant-owned", () => {
    for (const t of ["record_comments", "record_comment_attachments", "record_comment_mentions", "activity_events"])
      expect(TENANT_OWNED_TABLES).toContain(t)
  })
})

describe("comments & mentions", () => {
  it("parses unique structured mentions only", () => {
    expect(parseMentions("hi @[Bob](user:2) and @[Bob](user:2), @plain, @[X](user:abc)")).toEqual([2])
  })
  it("renders current names and 'Deleted user' for removed accounts", () => {
    const out = renderMentions("cc @[Old Name](user:2) @[Gone](user:99)", new Map([[2, "Bob Smith"]]))
    expect(out).toBe("cc @Bob Smith @Deleted user")
  })
  it("validates body, attachments, idempotency key and parent", () => {
    expect(() => validateComment({ body: "  " })).toThrow(CollabError)
    expect(() => validateComment({ body: "x".repeat(5001) })).toThrow(CollabError)
    expect(() => validateComment({ body: "ok", attachments: [{ name: "a", url: "javascript:alert(1)" }] })).toThrow(CollabError)
    expect(() => validateComment({ body: "ok", attachments: [{ name: "a", url: "//evil.com/x" }] })).toThrow(CollabError)
    expect(() => validateComment({ body: "ok", attachments: [{ name: "a", url: "http://plain.com/x" }] })).toThrow(CollabError)
    expect(() => validateComment({ body: "ok", attachments: [{ name: "a", url: "/f", sizeBytes: 26 * 1024 * 1024 }] })).toThrow(CollabError)
    expect(() => validateComment({ body: "ok", idempotencyKey: "short" })).toThrow(CollabError)
    expect(() => validateComment({ body: "ok", parentId: -2 })).toThrow(CollabError)
    const ok = validateComment({ body: "hi @[B](user:2)", attachments: [{ name: "a.pdf", url: "/api/dms/1" }], idempotencyKey: "abcdefgh-1" })
    expect(ok.mentionIds).toEqual([2])
    expect(ok.attachments).toHaveLength(1)
  })
  it("caps the number of mentions", () => {
    const body = Array.from({ length: 21 }, (_, i) => `@[u](user:${i + 1})`).join(" ")
    expect(() => validateComment({ body })).toThrow(CollabError)
  })
})

describe("deleted / deactivated users", () => {
  it("never leaks a missing user and labels deactivated ones", () => {
    expect(displayUser(null)).toEqual({ id: null, name: "Deleted user", active: false })
    expect(displayUser({ id: 3, name: "Carol", status: "inactive" }).name).toBe("Carol (deactivated)")
    expect(displayUser({ id: 4, name: "Dan", status: "active", lifecycle_state: "offboarded" }).active).toBe(false)
  })
})

describe("CRM events", () => {
  const base = { channel: "call", subjectType: "lead", subjectId: 1, sourceRef: "twilio:CA1", title: "Call" }
  it("accepts all five channels on CRM subjects only", () => {
    for (const channel of ["email", "call", "whatsapp", "meeting", "note"]) expect(validateCrmEvent({ ...base, channel }).channel).toBe(channel)
    expect(() => validateCrmEvent({ ...base, channel: "sms" })).toThrow(CollabError)
    expect(() => validateCrmEvent({ ...base, subjectType: "task" })).toThrow(CollabError)
    expect(() => validateCrmEvent({ ...base, sourceRef: "" })).toThrow(CollabError)
    expect(() => validateCrmEvent({ ...base, durationSeconds: -1 })).toThrow(CollabError)
  })
  it("dedupe key is stable per channel + source", () => {
    expect(crmDedupeKey({ channel: "call", sourceRef: "x" })).toBe(crmDedupeKey({ channel: "call", sourceRef: "x" }))
    expect(crmDedupeKey({ channel: "call", sourceRef: "x" })).not.toBe(crmDedupeKey({ channel: "email", sourceRef: "x" }))
  })
})

describe("hidden fields", () => {
  it("removes hidden and masks masked fields in both meta shapes", () => {
    const effects = new Map([
      ["salary", "hidden" as const],
      ["phone", "masked" as const],
    ])
    expect(redactActivityMeta({ field: "salary", from: 1, to: 2 }, effects).meta).toEqual({ redacted_fields: ["salary"] })
    const r = redactActivityMeta({ changes: { salary: { from: 1, to: 2 }, phone: "123", name: "A" } }, effects)
    expect(r.meta?.changes).toEqual({ phone: "••••", name: "A" })
    expect(JSON.stringify(r.meta)).not.toContain("123")
  })
})

describe("inbox ordering", () => {
  it("puts overdue first then soonest due then oldest", () => {
    const mk = (id: number, dueAt: string | null, createdAt = "2026-01-01T00:00:00Z"): InboxItem => ({
      kind: "task", id, title: "t", moduleKey: "tasks", status: "open", priority: null, dueAt, createdAt, link: "/",
    })
    const now = new Date("2026-06-01T00:00:00Z")
    const sorted = sortInbox([mk(1, null), mk(2, "2026-07-01T00:00:00Z"), mk(3, "2026-05-01T00:00:00Z"), mk(4, "2026-06-10T00:00:00Z")], now)
    expect(sorted.map((i) => i.id)).toEqual([3, 4, 2, 1])
  })
})
