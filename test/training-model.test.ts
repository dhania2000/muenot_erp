import { describe, it, expect } from "vitest"
import {
  scoreQuiz,
  clampScore,
  deriveStatus,
  isOverdue,
  meetsCompletionRule,
  lessonCompletable,
  policyAckState,
  ackVersionConflict,
  certificateNumber,
  normalizeEvidence,
  isMediaExpired,
  canAccessMedia,
  roleMatches,
  parseStringArray,
  validateCourse,
  validatePolicy,
} from "@/lib/training/model"

/**
 * Spec38 (#230-233) — Training & policy acknowledgment pure rules: scoring,
 * status/overdue, completion, inaccessible media, policy re-acknowledgment,
 * role targeting, evidence and validation. Clock-injected, DB-free.
 */

const NOW = new Date("2026-09-26T12:00:00Z")

describe("quiz scoring", () => {
  const qs = [
    { id: 1, correct_index: 0, points: 1 },
    { id: 2, correct_index: 2, points: 3 },
  ]
  it("weights by points and applies pass mark", () => {
    const r = scoreQuiz(qs, { 1: 1, 2: 2 }, 70)
    expect(r.score).toBe(75)
    expect(r.passed).toBe(true)
    expect(r.correctCount).toBe(1)
  })
  it("fails below the pass mark and with no questions", () => {
    expect(scoreQuiz(qs, { 1: 0 }, 70).passed).toBe(false)
    expect(scoreQuiz([], {}, 0).passed).toBe(false)
  })
  it("clamps pass scores", () => {
    expect(clampScore(150)).toBe(100)
    expect(clampScore(-3)).toBe(0)
    expect(clampScore("abc")).toBe(0)
  })
})

describe("assignment status", () => {
  it("completed wins over overdue", () => {
    expect(deriveStatus({ status: "started", due_date: "2026-01-01", completed_at: "2026-02-01" }, NOW)).toBe("completed")
  })
  it("incomplete past due is overdue", () => {
    expect(deriveStatus({ status: "started", due_date: "2026-09-01" }, NOW)).toBe("overdue")
    expect(deriveStatus({ status: "assigned", due_date: "2026-12-01" }, NOW)).toBe("assigned")
    expect(deriveStatus({ status: "started", due_date: null }, NOW)).toBe("started")
  })
  it("is not overdue on the due day itself", () => {
    const due = new Date(NOW)
    expect(isOverdue(due, NOW)).toBe(false)
    expect(isOverdue("not-a-date", NOW)).toBe(false)
  })
})

describe("completion rule", () => {
  it("requires every lesson and a passing quiz", () => {
    expect(meetsCompletionRule({ totalLessons: 3, completedLessons: 2, hasQuiz: false, quizPassed: false })).toBe(false)
    expect(meetsCompletionRule({ totalLessons: 3, completedLessons: 3, hasQuiz: true, quizPassed: false })).toBe(false)
    expect(meetsCompletionRule({ totalLessons: 3, completedLessons: 3, hasQuiz: true, quizPassed: true })).toBe(true)
    expect(meetsCompletionRule({ totalLessons: 2, completedLessons: 2, hasQuiz: false, quizPassed: false })).toBe(true)
  })
})

describe("inaccessible video / document", () => {
  it("text lessons need no media", () => {
    expect(lessonCompletable({ lessonType: "text", mediaId: null, media: null })).toEqual({ ok: true })
  })
  it("missing media blocks completion", () => {
    expect(lessonCompletable({ lessonType: "video", mediaId: null, media: null })).toEqual({ ok: false, reason: "media_missing" })
    expect(lessonCompletable({ lessonType: "document", mediaId: 9, media: null })).toEqual({ ok: false, reason: "media_missing" })
  })
  it("expired media blocks completion", () => {
    expect(
      lessonCompletable({ lessonType: "video", mediaId: 9, media: { expires_at: "2026-09-01T00:00:00Z" }, now: NOW }),
    ).toEqual({ ok: false, reason: "media_expired" })
    expect(
      lessonCompletable({ lessonType: "video", mediaId: 9, media: { expires_at: "2027-01-01T00:00:00Z" }, now: NOW }),
    ).toEqual({ ok: true })
  })
})

describe("media access control", () => {
  const base = { access: "assigned", expiresAt: null, isManager: false, mediaCourseIds: [5], employeeCourseIds: [] as number[], now: NOW }
  it("denies unassigned learners and allows assigned ones", () => {
    expect(canAccessMedia(base)).toEqual({ allowed: false, reason: "not_assigned" })
    expect(canAccessMedia({ ...base, employeeCourseIds: [5] }).allowed).toBe(true)
  })
  it("tenant-wide media and managers are allowed", () => {
    expect(canAccessMedia({ ...base, access: "tenant" }).allowed).toBe(true)
    expect(canAccessMedia({ ...base, isManager: true }).allowed).toBe(true)
  })
  it("expiry denies everyone, managers included", () => {
    expect(canAccessMedia({ ...base, isManager: true, expiresAt: "2026-01-01" })).toEqual({ allowed: false, reason: "expired" })
    expect(isMediaExpired(null, NOW)).toBe(false)
  })
})

describe("policy versions and acknowledgment", () => {
  it("a newer published version makes prior acks outdated", () => {
    expect(policyAckState(2, null)).toBe("pending")
    expect(policyAckState(2, 1)).toBe("outdated")
    expect(policyAckState(2, 2)).toBe("current")
  })
  it("rejects acknowledging a version the employee did not read", () => {
    expect(ackVersionConflict(3, 2)).toBe(true)
    expect(ackVersionConflict(3, "x")).toBe(true)
    expect(ackVersionConflict(3, 3)).toBe(false)
    expect(ackVersionConflict(3, undefined)).toBe(false)
  })
  it("normalizes and truncates evidence", () => {
    const e = normalizeEvidence({ ip: " 10.0.0.1 ", userAgent: "a".repeat(900), capturedAt: NOW })
    expect(e.ip).toBe("10.0.0.1")
    expect(e.userAgent).toHaveLength(400)
    expect(e.capturedAt).toBe(NOW.toISOString())
  })
})

describe("certificates, roles and validation", () => {
  it("certificate numbers are deterministic per assignment", () => {
    expect(certificateNumber(42, NOW)).toBe("CERT-2026-000042")
  })
  it("role targeting is case-insensitive with 'all' sentinel", () => {
    expect(roleMatches([], { designation: "Clerk" })).toBe(true)
    expect(roleMatches(["all"], {})).toBe(true)
    expect(roleMatches(["Driver"], { designation: "driver" })).toBe(true)
    expect(roleMatches(["Driver"], { designation: "Clerk", role: "staff" })).toBe(false)
  })
  it("parses string arrays defensively", () => {
    expect(parseStringArray('["a"," ","b"]')).toEqual(["a", "b"])
    expect(parseStringArray("{bad")).toEqual([])
  })
  it("validates courses", () => {
    expect(validateCourse({ title: "" }).ok).toBe(false)
    expect(validateCourse({ title: "Safety", due_days: -1 }).ok).toBe(false)
    const ok = validateCourse({ title: " Safety ", roles: ["Driver"] })
    expect(ok.ok && ok.value).toMatchObject({ title: "Safety", pass_score: 70, roles: ["Driver"], active: true })
  })
  it("validates policies", () => {
    expect(validatePolicy({ title: "Code", body: "" }).ok).toBe(false)
    expect(validatePolicy({ title: "Code", body: "x", effective_date: "nope" }).ok).toBe(false)
    const ok = validatePolicy({ title: "Code", body: "text", effective_date: "2026-10-01" })
    expect(ok.ok && ok.value.effective_date).toBe("2026-10-01")
  })
})
