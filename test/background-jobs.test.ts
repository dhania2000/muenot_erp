import { describe, expect, it } from "vitest"
import { BACKGROUND_JOB_STATUSES, BACKGROUND_JOB_TYPES, retryDelaySeconds } from "@/lib/background-jobs"

describe("SPEC 42 background job queue", () => {
  it("uses a reviewed job type registry and explicit terminal states", () => {
    expect(BACKGROUND_JOB_TYPES).toContain("email.send")
    expect(BACKGROUND_JOB_STATUSES).toEqual(expect.arrayContaining(["queued", "running", "completed", "dead_letter", "cancelled"]))
  })

  it("uses capped exponential backoff for retries", () => {
    expect(retryDelaySeconds(1, 30)).toBe(30)
    expect(retryDelaySeconds(3, 30)).toBe(120)
    expect(retryDelaySeconds(20, 3600)).toBe(3600)
  })
})
