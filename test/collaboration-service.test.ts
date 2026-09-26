import { beforeEach, describe, expect, it, vi } from "vitest"

type Row = Record<string, any>
const db = vi.hoisted(() => ({
  leads: [] as Row[],
  users: [] as Row[],
  comments: [] as Row[],
  attachments: [] as Row[],
  mentions: [] as Row[],
  tasks: [] as Row[],
  failNextInsert: null as null | Error,
}))

const mocks = vi.hoisted(() => ({
  canActOnRecord: vi.fn(),
  getScope: vi.fn(),
  fieldPolicyRulesFor: vi.fn(),
  fieldSecurityActorFromSession: vi.fn(),
  getTimeline: vi.fn(),
  recordActivity: vi.fn(),
  recordActivitySafe: vi.fn(),
  recordAuditLog: vi.fn(),
  listInboxForUser: vi.fn(),
  enqueueNotification: vi.fn(),
}))

function handle(sql: string, p: any[]): any {
  const s = sql.replace(/\s+/g, " ")
  if (/FROM `sales_leads` WHERE tenant_id = \? AND id = \?/.test(s)) return db.leads.filter((r) => r.tenant_id === p[0] && r.id === p[1])
  if (/FROM users WHERE tenant_id = \? AND id IN/.test(s)) return db.users.filter((u) => u.tenant_id === p[0] && p.slice(1).includes(u.id))
  if (/FROM users WHERE tenant_id = \? AND status = 'active'/.test(s))
    return db.users.filter((u) => u.tenant_id === p[0] && u.status === "active" && u.id !== p[1])
  if (/FROM record_comments WHERE tenant_id = \? AND author_id = \? AND idempotency_key/.test(s))
    return db.comments.filter((c) => c.tenant_id === p[0] && c.author_id === p[1] && c.idempotency_key === p[2])
  if (/SELECT id, parent_id, author_id, body/.test(s))
    return db.comments.filter((c) => c.tenant_id === p[0] && c.subject_type === p[1] && c.subject_id === p[2])
  if (/FROM record_comment_attachments/.test(s)) return db.attachments.filter((a) => a.tenant_id === p[0] && p.slice(1).includes(a.comment_id))
  if (/FROM record_comment_mentions/.test(s)) return db.mentions.filter((m) => m.tenant_id === p[0] && p.slice(1).includes(m.comment_id))
  if (/SELECT id, author_id, deleted_at FROM record_comments/.test(s))
    return db.comments.filter((c) => c.tenant_id === p[0] && c.id === p[1] && c.subject_type === p[2] && c.subject_id === p[3])
  if (/SELECT id FROM record_comments WHERE tenant_id = \? AND id = \?/.test(s))
    return db.comments.filter((c) => c.tenant_id === p[0] && c.id === p[1] && c.subject_type === p[2] && c.subject_id === p[3] && !c.deleted_at)
  if (/UPDATE record_comments SET deleted_at/.test(s)) {
    const c = db.comments.find((x) => x.tenant_id === p[1] && x.id === p[2])
    if (c) Object.assign(c, { deleted_at: "now", deleted_by: p[0] })
    return []
  }
  if (/UPDATE record_comments SET activity_event_id/.test(s)) return []
  if (/FROM tasks/.test(s))
    return db.tasks.filter(
      (t) => t.tenant_id === p[0] && ((t.assignee_id === p[1] && !["Done", "Cancelled"].includes(t.status)) || (t.approver_id === p[2] && t.approval_status === "pending")),
    )
  throw new Error(`unexpected SQL: ${s}`)
}

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, p: any[] = []) => handle(sql, p)),
  withTransaction: vi.fn(async (fn: any) => {
    const staged = { comments: [] as Row[], attachments: [] as Row[], mentions: [] as Row[] }
    const c = {
      query: async (sql: string, p: any[]) => {
        if (/INSERT INTO record_comments /.test(sql)) {
          if (db.failNextInsert) {
            const e = db.failNextInsert
            db.failNextInsert = null
            throw e
          }
          const id = db.comments.length + staged.comments.length + 1
          staged.comments.push({ id, tenant_id: p[0], subject_type: p[1], subject_id: p[2], parent_id: p[3], author_id: p[4], body: p[5], idempotency_key: p[6], request_hash: p[7], deleted_at: null, created_at: "2026-09-01T00:00:00Z" })
          return [{ insertId: id }]
        }
        if (/INSERT INTO record_comment_attachments/.test(sql)) staged.attachments.push({ tenant_id: p[0], comment_id: p[1], name: p[2], url: p[3], mime_type: p[4], size_bytes: p[5] })
        if (/INSERT INTO record_comment_mentions/.test(sql)) staged.mentions.push({ tenant_id: p[0], comment_id: p[1], user_id: p[2], status: p[3] })
        return [{}]
      },
    }
    const result = await fn(c)
    db.comments.push(...staged.comments)
    db.attachments.push(...staged.attachments)
    db.mentions.push(...staged.mentions)
    return result
  }),
}))
vi.mock("@/lib/permission-enforce", () => ({ canActOnRecord: mocks.canActOnRecord }))
vi.mock("@/lib/permission-store", () => ({ getScope: mocks.getScope }))
vi.mock("@/lib/field-security", () => ({
  fieldPolicyRulesFor: mocks.fieldPolicyRulesFor,
  fieldSecurityActorFromSession: mocks.fieldSecurityActorFromSession,
}))
vi.mock("@/lib/field-security-model", () => ({
  resolveFieldEffects: (rules: any[]) => new Map(rules.map((r) => [r.field, { effect: r.effect }])),
  effectRedactsValue: (e: string) => e === "hidden" || e === "masked",
}))
vi.mock("@/lib/activity/db", () => ({
  getTimeline: mocks.getTimeline,
  recordActivity: mocks.recordActivity,
  recordActivitySafe: mocks.recordActivitySafe,
}))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLog: mocks.recordAuditLog }))
vi.mock("@/lib/approval-authority", () => ({ listInboxForUser: mocks.listInboxForUser }))
vi.mock("@/lib/tasks/schema", () => ({ ensureTaskSchema: vi.fn() }))
vi.mock("@/lib/notification-engine/schema", () => ({ ensureNotificationEngineSchema: vi.fn() }))
vi.mock("@/lib/notification-engine/service", () => ({ enqueueNotification: mocks.enqueueNotification }))
vi.mock("@/lib/collaboration/schema", () => ({ ensureCollaborationSchema: vi.fn() }))

import {
  addComment,
  deleteComment,
  getInbox,
  getRecordActivity,
  mentionCandidates,
  recordCrmCommunication,
  resolveDeepLink,
} from "@/lib/collaboration/service"
import { CollabError } from "@/lib/collaboration/model"

const T1 = 1
const T2 = 2
const alice = { userId: 1, role: "employee", name: "Alice", email: "a@x", tenantId: T1 } as any
const bob = { userId: 2, role: "employee", name: "Bob", email: "b@x", tenantId: T1 } as any
const dan = { userId: 4, role: "employee", name: "Dan", email: "d@x", tenantId: T1 } as any
const admin = { userId: 5, role: "admin", name: "Root", email: "r@x", tenantId: T1 } as any
const eve = { userId: 9, role: "admin", name: "Eve", email: "e@x", tenantId: T2 } as any

async function expectStatus(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof CollabError && e.status === status)
}

beforeEach(() => {
  db.leads = [
    { tenant_id: T1, id: 10, company_name: "Acme", created_by: 1, assigned_to: 1, salary: 1 },
    { tenant_id: T2, id: 20, company_name: "Globex", created_by: 9 },
  ]
  db.users = [
    { tenant_id: T1, id: 1, name: "Alice", status: "active", role: "employee" },
    { tenant_id: T1, id: 2, name: "Bob", status: "active", role: "employee" },
    { tenant_id: T1, id: 3, name: "Carol", status: "inactive", role: "employee" },
    { tenant_id: T1, id: 4, name: "Dan", status: "active", role: "employee" },
    { tenant_id: T1, id: 5, name: "Root", status: "active", role: "admin" },
    { tenant_id: T2, id: 9, name: "Eve", status: "active", role: "admin" },
  ]
  db.comments = []
  db.attachments = []
  db.mentions = []
  db.tasks = []
  db.failNextInsert = null
  vi.clearAllMocks()
  // Dan has no access to leads; Bob can view but not update.
  mocks.canActOnRecord.mockImplementation(async (s: any, _m: string, action: string) => {
    if (s.userId === 4) return false
    if (s.userId === 2 && action === "update") return false
    return true
  })
  mocks.getScope.mockResolvedValue("all")
  mocks.fieldPolicyRulesFor.mockResolvedValue([])
  mocks.fieldSecurityActorFromSession.mockResolvedValue({ userId: 1 })
  mocks.getTimeline.mockResolvedValue({ events: [], nextCursor: null })
  mocks.recordActivity.mockResolvedValue({ id: 77, duplicate: false })
  mocks.recordActivitySafe.mockResolvedValue({ id: 78 })
  mocks.enqueueNotification.mockResolvedValue(500)
  mocks.listInboxForUser.mockResolvedValue([])
})

describe("tenant isolation & record permissions", () => {
  it("cross-tenant record ids look like missing records (404)", async () => {
    await expectStatus(getRecordActivity(alice, T1, "lead", 20), 404)
    await expectStatus(addComment(eve, T2, "lead", 10, { body: "hi" }), 404)
    expect(db.comments).toHaveLength(0)
  })
  it("unauthorized users get 404, not 403, and cannot comment", async () => {
    await expectStatus(getRecordActivity(dan, T1, "lead", 10), 404)
    await expectStatus(addComment(dan, T1, "lead", 10, { body: "x" }), 404)
    await expectStatus(mentionCandidates(dan, T1, "lead", 10, null), 404)
  })
  it("unknown subject types and bad ids are rejected before any query", async () => {
    await expectStatus(getRecordActivity(alice, T1, "users", 1), 404)
    await expectStatus(getRecordActivity(alice, T1, "lead", "1 OR 1=1"), 400)
  })
  it("mention candidates are tenant-scoped and active-only", async () => {
    const { users } = await mentionCandidates(alice, T1, "lead", 10, "")
    expect(users.map((u) => u.id).sort()).toEqual([2, 4, 5])
  })
})

describe("comments, mentions and attachments", () => {
  it("creates a comment with attachments, notifies only authorized active mentions, and audits", async () => {
    const res = await addComment(alice, T1, "lead", 10, {
      body: "cc @[Bob](user:2) @[Carol](user:3) @[Dan](user:4) @[Me](user:1) @[Eve](user:9)",
      attachments: [{ name: "brief.pdf", url: "/api/dms/files/1" }],
    })
    expect(res.duplicate).toBe(false)
    const byUser = Object.fromEntries(res.mentions.map((m) => [m.userId, m.status]))
    expect(byUser).toEqual({ 1: "self", 2: "notified", 3: "inactive", 4: "no_access" })
    expect(byUser[9]).toBeUndefined() // other tenant is silently dropped
    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(1)
    const payload = mocks.enqueueNotification.mock.calls[0][1]
    expect(payload).toMatchObject({ tenantId: T1, userId: 2, key: `mention:${res.commentId}:2` })
    expect(payload.link).toBe(`/api/collaboration/open/lead/10?comment=${res.commentId}`)
    expect(db.attachments).toHaveLength(1)
    expect(mocks.recordActivitySafe).toHaveBeenCalledWith(expect.objectContaining({ ref_type: "record_comment" }), { dedupeKey: `comment:${res.commentId}` })
    expect(mocks.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "collaboration.comment.create" }))
  })

  it("is idempotent per key and rejects key reuse with a different body", async () => {
    const first = await addComment(alice, T1, "lead", 10, { body: "once @[Bob](user:2)", idempotencyKey: "key-12345" })
    const again = await addComment(alice, T1, "lead", 10, { body: "once @[Bob](user:2)", idempotencyKey: "key-12345" })
    expect(again).toMatchObject({ commentId: first.commentId, duplicate: true })
    expect(db.comments).toHaveLength(1)
    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(1)
    await expectStatus(addComment(alice, T1, "lead", 10, { body: "different", idempotencyKey: "key-12345" }), 409)
  })

  it("recovers the winner on a concurrent duplicate-key race", async () => {
    // Produce the winning row (with its real request hash), then hide it so the retry misses the pre-check.
    const first = await addComment(alice, T1, "lead", 10, { body: "race", idempotencyKey: "race-key-1" })
    const winner = db.comments[0]
    db.comments = []
    const { withTransaction } = await import("@/lib/db")
    ;(withTransaction as any).mockImplementationOnce(async () => {
      db.comments.push(winner) // concurrent request commits first
      throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" })
    })
    const res = await addComment(alice, T1, "lead", 10, { body: "race", idempotencyKey: "race-key-1" })
    expect(res).toMatchObject({ commentId: first.commentId, duplicate: true })
  })

  it("propagates storage failures without notifying or auditing", async () => {
    db.failNextInsert = new Error("db down")
    await expect(addComment(alice, T1, "lead", 10, { body: "hi @[Bob](user:2)" })).rejects.toThrow("db down")
    expect(db.comments).toHaveLength(0)
    expect(mocks.recordAuditLog).not.toHaveBeenCalled()
    expect(mocks.recordActivitySafe).not.toHaveBeenCalled()
  })

  it("rejects parent comments from another record", async () => {
    await expectStatus(addComment(alice, T1, "lead", 10, { body: "reply", parentId: 123 }), 422)
  })

  it("renders deleted authors/mentions safely and hides deleted comment content", async () => {
    await addComment(bob, T1, "lead", 10, { body: "hello @[Carol](user:3)", attachments: [{ name: "a", url: "/x" }] })
    const second = await addComment(alice, T1, "lead", 10, { body: "secret" })
    db.users = db.users.filter((u) => u.id !== 2) // Bob hard-deleted
    await deleteComment(alice, T1, "lead", 10, second.commentId)
    const act = await getRecordActivity(alice, T1, "lead", 10)
    expect(act.comments[0].author).toEqual({ id: null, name: "Deleted user", active: false })
    expect(act.comments[0].body).toBe("hello @Carol (deactivated)")
    expect(act.comments[1]).toMatchObject({ deleted: true, body: null, attachments: [], mentions: [] })
  })

  it("only author or admin can delete; delete is idempotent and audited", async () => {
    const c = await addComment(alice, T1, "lead", 10, { body: "mine" })
    await expectStatus(deleteComment(bob, T1, "lead", 10, c.commentId), 403)
    expect(await deleteComment(admin, T1, "lead", 10, c.commentId)).toEqual({ deleted: true, alreadyDeleted: false })
    expect(await deleteComment(alice, T1, "lead", 10, c.commentId)).toEqual({ deleted: true, alreadyDeleted: true })
    await expectStatus(deleteComment(eve, T2, "lead", 10, c.commentId), 404)
    expect(mocks.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "collaboration.comment.delete" }))
  })
})

describe("hidden fields in the timeline", () => {
  const events = [
    { id: 1, kind: "status_change", title: "Updated", actor_id: 2, ref_type: null, occurred_at: "2026-09-01", meta: { changes: { salary: { from: 1, to: 2 }, stage: "won" } } },
    { id: 2, kind: "note", title: "comment", actor_id: 1, ref_type: "record_comment", occurred_at: "2026-09-01", meta: null },
  ]
  it("redacts protected fields and removes duplicated comment events", async () => {
    mocks.getTimeline.mockResolvedValue({ events, nextCursor: null })
    mocks.fieldPolicyRulesFor.mockResolvedValue([{ field: "salary", effect: "hidden" }])
    const act = await getRecordActivity(alice, T1, "lead", 10)
    expect(act.events).toHaveLength(1)
    expect(act.events[0].meta).toEqual({ changes: { stage: "won" }, redacted_fields: ["salary"] })
  })
  it("fails closed when field security cannot be resolved", async () => {
    mocks.getTimeline.mockResolvedValue({ events, nextCursor: null })
    mocks.fieldPolicyRulesFor.mockResolvedValue([{ field: "salary", effect: "visible" }])
    mocks.fieldSecurityActorFromSession.mockRejectedValue(new Error("boom"))
    const act = await getRecordActivity(alice, T1, "lead", 10)
    expect(JSON.stringify(act.events[0].meta)).not.toContain("salary\":{")
  })
})

describe("CRM communications on the timeline", () => {
  const evt = { channel: "whatsapp", subjectType: "lead", subjectId: 10, sourceRef: "wa:msg-1", title: "WhatsApp message", direction: "inbound" }
  it("records email/call/whatsapp/meeting/note events with a dedupe key and audit", async () => {
    for (const channel of ["email", "call", "whatsapp", "meeting", "note"]) {
      await recordCrmCommunication(alice, T1, { ...evt, channel, sourceRef: `${channel}:1`, direction: channel === "note" ? "internal" : "outbound" })
    }
    expect(mocks.recordActivity).toHaveBeenCalledTimes(5)
    expect(mocks.recordActivity.mock.calls[2]).toEqual([
      expect.objectContaining({ kind: "whatsapp", subject_type: "lead", subject_id: 10, source_module: "crm" }),
      { dedupeKey: "crm:whatsapp:whatsapp:1" },
    ])
    expect(mocks.recordAuditLog).toHaveBeenCalledTimes(5)
  })
  it("provider retries are idempotent and not re-audited", async () => {
    mocks.recordActivity.mockResolvedValue({ id: 77, duplicate: true })
    expect(await recordCrmCommunication(alice, T1, evt)).toEqual({ eventId: 77, duplicate: true })
    expect(mocks.recordAuditLog).not.toHaveBeenCalled()
  })
  it("requires update permission and tenant ownership; rejects non-CRM subjects", async () => {
    await expectStatus(recordCrmCommunication(bob, T1, evt), 404)
    await expectStatus(recordCrmCommunication(eve, T2, evt), 404)
    await expectStatus(recordCrmCommunication(alice, T1, { ...evt, subjectType: "task" }), 422)
    expect(mocks.recordActivity).not.toHaveBeenCalled()
  })
})

describe("unified inbox", () => {
  it("merges own tasks, task approvals and module approvals, filtering unauthorized modules", async () => {
    db.tasks = [
      { tenant_id: T1, id: 1, title: "Open", status: "To Do", assignee_id: 1, created_at: "2026-01-01", due_date: "2020-01-01" },
      { tenant_id: T1, id: 2, title: "Done", status: "Done", assignee_id: 1, created_at: "2026-01-01" },
      { tenant_id: T1, id: 3, title: "Approve", status: "To Do", approver_id: 1, approval_status: "pending", created_at: "2026-01-02" },
      { tenant_id: T2, id: 4, title: "Other tenant", status: "To Do", assignee_id: 1, created_at: "2026-01-01" },
    ]
    mocks.listInboxForUser.mockResolvedValue([
      { id: 50, moduleKey: "expense", title: "Expense", status: "pending", createdAt: "2026-02-01" },
      { id: 51, moduleKey: "leave", title: "Leave", status: "pending", createdAt: "2026-02-01" },
    ])
    mocks.getScope.mockImplementation(async (_u: number, _r: string, perm: string) => (perm === "hr.leaves" ? "none" : "own"))
    const inbox = await getInbox(alice, T1)
    expect(inbox.items.map((i) => `${i.kind}:${i.id}`)).toEqual(["task:1", "approval:3", "approval:50"])
    expect(inbox.counts).toEqual({ tasks: 1, approvals: 2, hiddenApprovals: 1 })
  })
  it("fails closed when a permission lookup errors", async () => {
    mocks.listInboxForUser.mockResolvedValue([{ id: 50, moduleKey: "expense", title: "E", status: "pending", createdAt: "2026-02-01" }])
    mocks.getScope.mockRejectedValue(new Error("perm store down"))
    const inbox = await getInbox(alice, T1)
    expect(inbox.items).toHaveLength(0)
    expect(inbox.counts.hiddenApprovals).toBe(1)
  })
})

describe("permission-aware deep links", () => {
  it("re-checks access at click time", async () => {
    expect(await resolveDeepLink(bob, T1, "lead", 10, "7")).toEqual({ allowed: true, url: "/modules/sales/leads/10#comment-7" })
    expect(await resolveDeepLink(dan, T1, "lead", 10, "7")).toEqual({ allowed: false, url: "/notifications?denied=1" })
    expect(await resolveDeepLink(eve, T2, "lead", 10, null)).toEqual({ allowed: false, url: "/notifications?denied=1" })
    expect((await resolveDeepLink(bob, T1, "lead", 10, "7#evil")).url).toBe("/modules/sales/leads/10")
  })
})
