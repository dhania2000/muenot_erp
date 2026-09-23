import { describe, expect, it } from "vitest"
import { CRON_JOB_DEFINITIONS, matchesCronExpression, validateCronExpression } from "@/lib/cron-jobs"

describe(" safe cron configuration", () => {
  it("keeps an allow-list of internal endpoints", () => {
    expect(CRON_JOB_DEFINITIONS.length).toBeGreaterThan(20)
    expect(CRON_JOB_DEFINITIONS.every((job) => job.endpoint.startsWith("/api/cron/") || job.endpoint.startsWith("/api/marketing/"))).toBe(true)
    expect(new Set(CRON_JOB_DEFINITIONS.map((job) => job.key)).size).toBe(CRON_JOB_DEFINITIONS.length)
  })

  it("accepts standard five-field expressions and rejects command injection", () => {
    expect(validateCronExpression("*/15 * * * *").ok).toBe(true)
    expect(validateCronExpression("0 9 1 */3 *").ok).toBe(true)
    expect(validateCronExpression("* * * * *; rm -rf /").ok).toBe(false)
    expect(validateCronExpression("@reboot").ok).toBe(false)
  })

  it("matches schedules in the configured timezone", () => {
    const at = new Date("2026-09-20T03:30:00.000Z")
    expect(matchesCronExpression("0 9 * * *", at, "Asia/Kolkata")).toBe(true)
    expect(matchesCronExpression("30 9 * * *", at, "Asia/Kolkata")).toBe(false)
  })
})
