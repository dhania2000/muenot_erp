import { describe, expect, it } from "vitest"
import { CRON_JOB_DEFINITIONS } from "@/lib/cron-jobs"
import { getSchedulerCategory, SCHEDULER_CATEGORIES, SCHEDULER_CATEGORY_LABELS } from "@/lib/scheduler"

describe(" central scheduler", () => {
  it("assigns every reviewed cron job to a scheduler category", () => {
    expect(CRON_JOB_DEFINITIONS.every((job) => getSchedulerCategory(job.key) !== null)).toBe(true)
    expect(new Set(CRON_JOB_DEFINITIONS.map((job) => getSchedulerCategory(job.key))).size).toBeGreaterThan(5)
  })

  it("exposes all required platform categories, including extension slots", () => {
    expect(SCHEDULER_CATEGORIES).toHaveLength(10)
    expect(SCHEDULER_CATEGORIES.every((category) => SCHEDULER_CATEGORY_LABELS[category])).toBe(true)
    expect(getSchedulerCategory("payroll")).toBeNull()
    expect(getSchedulerCategory("ai_task_worker")).toBeNull()
  })
})
