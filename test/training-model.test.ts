import { describe, it, expect } from "vitest"
import {
  COURSE_STATUSES,
  LESSON_TYPES,
  ASSIGNMENT_STATUSES,
  DEFAULT_PASS_MARK,
  DEFAULT_DUE_DAYS,
  DEFAULT_ACK_STATEMENT,
  TrainingError,
  isValidDate,
  daysBetween,
  addDays,
  validateAudience,
  parseAudienceConfig,
  validateCourseInput,
  validateModuleInput,
  validateLessonInput,
  validateQuizQuestionInput,
  scoreQuiz,
  computeAssignmentStatus,
  isCourseComplete,
  validatePolicyInput,
  validatePolicyVersionInput,
  normalizeAckEvidence,
  needsAcknowledgment,
} from "@/lib/training/model"

/**
 * Spec38 (#230-233) — Training & Policy Acknowledgment pure domain model.
 * DB-free and clock-injectable so validation, scoring, completion, overdue and
 * re-acknowledgment rules are pinned deterministically.
 */

describe("training-model — date helpers", () => {
  it("validates ISO dates", () => {
    expect(isValidDate("2026-02-28")).toBe(true)
    expect(isValidDate("2026-02-28T10:00:00Z")).toBe(true)
    expect(isValidDate("28-02-2026")).toBe(false)
    expect(isValidDate(null)).toBe(false)
  })
  it("computes whole days between dates and adds days", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30)
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30)
    expect(addDays("2026-01-01", 30)).toBe("2026-01-31")
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01")
  })
})

describe("training-model — audience", () => {
  it("returns empty config for 'all'", () => {
    expect(validateAudience("all", { roles: ["x"] })).toEqual({})
  })
  it("requires selections for targeted audiences and dedups", () => {
    expect(() => validateAudience("role", {})).toThrow(/at least one role/i)
    expect(validateAudience("role", { roles: ["staff", "staff", "manager"] })).toEqual({ roles: ["staff", "manager"] })
    expect(() => validateAudience("employees", { employeeIds: [] })).toThrow(/at least one employee/i)
    expect(validateAudience("employees", { employeeIds: [1, 1, 2] })).toEqual({ employeeIds: [1, 2] })
  })
  it("rejects an unknown audience type", () => {
    expect(() => validateAudience("bogus" as any, {})).toThrow(/Invalid audience type/i)
  })
  it("parses a JSON string audience config", () => {
    expect(parseAudienceConfig('{"roles":["a"]}')).toEqual({ roles: ["a"] })
    expect(parseAudienceConfig("not json")).toEqual({})
  })
})

describe("training-model — validateCourseInput", () => {
  const good = { title: "Fire Safety", audience_type: "all" }
  it("applies defaults", () => {
    const c = validateCourseInput(good)
    expect(c.status).toBe("draft")
    expect(c.pass_mark).toBe(DEFAULT_PASS_MARK)
    expect(c.due_days).toBe(DEFAULT_DUE_DAYS)
    expect(c.mandatory).toBe(0)
    expect(COURSE_STATUSES).toContain(c.status)
  })
  it("requires a title on create but not update", () => {
    expect(() => validateCourseInput({ audience_type: "all" })).toThrow(/title is required/i)
    expect(() => validateCourseInput({ audience_type: "all" }, true)).not.toThrow()
  })
  it("clamps pass_mark and validates status + role audience", () => {
    expect(() => validateCourseInput({ ...good, pass_mark: 150 })).toThrow(/Pass mark/i)
    expect(() => validateCourseInput({ ...good, status: "live" })).toThrow(/Invalid course status/i)
    const c = validateCourseInput({ title: "X", audience_type: "role", audience_config: { roles: ["staff"] }, mandatory: true })
    expect(c.audience_type).toBe("role")
    expect(c.mandatory).toBe(1)
  })
})

describe("training-model — validateModuleInput / validateLessonInput", () => {
  it("validates a module", () => {
    expect(() => validateModuleInput({})).toThrow(/Module title is required/i)
    expect(validateModuleInput({ title: "Intro", sort_order: 2 }).sort_order).toBe(2)
  })
  it("requires some lesson content", () => {
    expect(() => validateLessonInput({ title: "L1", lesson_type: "document" })).toThrow(/needs an uploaded file/i)
    expect(validateLessonInput({ title: "L1", lesson_type: "video", media_file_id: 5 }).media_file_id).toBe(5)
    expect(LESSON_TYPES).toContain(validateLessonInput({ title: "L1", content: "hi" }).lesson_type)
  })
  it("rejects a bad lesson type and a non-http external url", () => {
    expect(() => validateLessonInput({ title: "L", lesson_type: "audio", content: "x" })).toThrow(/Invalid lesson type/i)
    expect(() => validateLessonInput({ title: "L", external_url: "ftp://x" })).toThrow(/http/i)
  })
})

describe("training-model — validateQuizQuestionInput", () => {
  const good = { question: "2+2?", options: ["3", "4", "5"], correct_index: 1 }
  it("normalizes options and correct index", () => {
    const q = validateQuizQuestionInput(good)
    expect(q.options).toEqual(["3", "4", "5"])
    expect(q.correct_index).toBe(1)
  })
  it("accepts a JSON string for options", () => {
    expect(validateQuizQuestionInput({ ...good, options: '["a","b"]', correct_index: 0 }).options).toEqual(["a", "b"])
  })
  it("requires >= 2 options and an in-range correct index", () => {
    expect(() => validateQuizQuestionInput({ ...good, options: ["only"] })).toThrow(/at least two/i)
    expect(() => validateQuizQuestionInput({ ...good, correct_index: 9 })).toThrow(/between 0 and 2|out of range/i)
  })
})

describe("training-model — scoreQuiz", () => {
  const qs = [
    { id: 1, correct_index: 0 },
    { id: 2, correct_index: 2 },
    { id: 3, correct_index: 1 },
  ]
  it("scores a perfect attempt", () => {
    const r = scoreQuiz(qs, { 1: 0, 2: 2, 3: 1 }, 70)
    expect(r).toEqual({ total: 3, correct: 3, score: 100, passed: true })
  })
  it("scores a partial attempt and fails below the pass mark", () => {
    const r = scoreQuiz(qs, { 1: 0, 2: 0, 3: 0 }, 70)
    expect(r.correct).toBe(1)
    expect(r.score).toBe(33)
    expect(r.passed).toBe(false)
  })
  it("treats a course with no questions as vacuously passed", () => {
    expect(scoreQuiz([], {}, 70)).toEqual({ total: 0, correct: 0, score: 100, passed: true })
  })
  it("counts missing answers as wrong", () => {
    const r = scoreQuiz(qs, { 1: 0 }, 50)
    expect(r.correct).toBe(1)
    expect(r.passed).toBe(false)
  })
})

describe("training-model — computeAssignmentStatus", () => {
  const now = new Date("2026-06-15T00:00:00Z")
  it("returns completed for a completed assignment regardless of due date", () => {
    expect(computeAssignmentStatus({ status: "completed", completed_at: "2026-06-01", due_date: "2026-05-01" }, now)).toBe("completed")
  })
  it("returns overdue when past due and not completed", () => {
    expect(computeAssignmentStatus({ status: "started", started_at: "2026-06-01", due_date: "2026-06-10" }, now)).toBe("overdue")
  })
  it("returns started when begun and not yet due", () => {
    expect(computeAssignmentStatus({ status: "started", started_at: "2026-06-10", due_date: "2026-06-30" }, now)).toBe("started")
  })
  it("returns assigned for a fresh assignment", () => {
    expect(computeAssignmentStatus({ status: "assigned", due_date: "2026-06-30" }, now)).toBe("assigned")
    expect(ASSIGNMENT_STATUSES).toContain(computeAssignmentStatus({ status: "assigned" }, now))
  })
})

describe("training-model — isCourseComplete", () => {
  it("completes when all lessons done and no quiz", () => {
    expect(isCourseComplete({ lessonsTotal: 3, lessonsCompleted: 3, hasQuiz: false, quizPassed: false })).toBe(true)
  })
  it("requires the quiz to pass when present", () => {
    expect(isCourseComplete({ lessonsTotal: 3, lessonsCompleted: 3, hasQuiz: true, quizPassed: false })).toBe(false)
    expect(isCourseComplete({ lessonsTotal: 3, lessonsCompleted: 3, hasQuiz: true, quizPassed: true })).toBe(true)
  })
  it("is incomplete while lessons remain", () => {
    expect(isCourseComplete({ lessonsTotal: 3, lessonsCompleted: 2, hasQuiz: false, quizPassed: false })).toBe(false)
  })
  it("cannot complete an empty course with no quiz", () => {
    expect(isCourseComplete({ lessonsTotal: 0, lessonsCompleted: 0, hasQuiz: false, quizPassed: false })).toBe(false)
  })
})

describe("training-model — policy validation", () => {
  it("defaults requires_acknowledgment to on", () => {
    const p = validatePolicyInput({ title: "Code of Conduct" })
    expect(p.requires_acknowledgment).toBe(1)
    expect(p.audience_type).toBe("all")
  })
  it("requires content or a document on a version", () => {
    expect(() => validatePolicyVersionInput({})).toThrow(/written content or an attached document/i)
    expect(validatePolicyVersionInput({ content: "Be nice." }).content).toBe("Be nice.")
    expect(validatePolicyVersionInput({ media_file_id: 7 }).media_file_id).toBe(7)
  })
  it("rejects an invalid effective date", () => {
    expect(() => validatePolicyVersionInput({ content: "x", effective_date: "31-01-2026" })).toThrow(/Effective date is invalid/i)
  })
})

describe("training-model — acknowledgment evidence + re-ack", () => {
  it("requires a signature and defaults the statement", () => {
    expect(() => normalizeAckEvidence({ ip: "1.2.3.4" })).toThrow(/type your full name/i)
    const e = normalizeAckEvidence({ ip: "1.2.3.4", user_agent: "UA", signature_name: "Asha Rao" })
    expect(e.signature_name).toBe("Asha Rao")
    expect(e.statement).toBe(DEFAULT_ACK_STATEMENT)
    expect(e.ip).toBe("1.2.3.4")
  })
  it("needs acknowledgment for a new current version, not for one already acknowledged", () => {
    expect(needsAcknowledgment(5, [3, 4])).toBe(true) // policy re-published → must re-ack
    expect(needsAcknowledgment(5, [3, 4, 5])).toBe(false)
    expect(needsAcknowledgment(null, [])).toBe(false) // nothing published
  })
})

describe("training-model — TrainingError carries a status", () => {
  it("defaults to 400", () => {
    const e = new TrainingError("bad")
    expect(e.status).toBe(400)
    expect(e.name).toBe("TrainingError")
  })
})
