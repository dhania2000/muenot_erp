import { describe, expect, it } from "vitest"
import { validateCronExpression as platformValidate } from "@/lib/cron-jobs"
import { classifyJobFailure, retryDisposition } from "@/lib/job-retry-policy"
import {
  displayRunStatus,
  instantsForWallTime,
  nextRunAt,
  nextRunTimes,
  planTenantJobTick,
  TenantJobError,
  validateTenantCron,
  validateTenantJobInput,
} from "@/lib/tenant-jobs/model"

const iso = (d: Date | null) => d?.toISOString() ?? null
const NOW = new Date("2027-01-10T00:00:00Z")
const base = {
  name: "Nightly export",
  actionKey: "data_export.run",
  actionParams: { datasetKey: "sales.leads", format: "csv" },
  presetKey: "daily_0900",
  timezone: "America/New_York",
}

describe("cron validation", () => {
  it("keeps the platform validator behaviour after sharing the parser", () => {
    expect(platformValidate("*/15 * * * *").ok).toBe(true)
    expect(platformValidate("0 9 1 */3 *").ok).toBe(true)
    expect(platformValidate("60 * * * *").ok).toBe(false)
    expect(platformValidate("0 9 * *").ok).toBe(false)
    expect(platformValidate("1a * * * *").ok).toBe(false)
    expect(platformValidate("*/5/2 * * * *").ok).toBe(false)
  })
  it("enforces the tenant minimum interval", () => {
    expect(validateTenantCron("* * * * *").ok).toBe(false)
    expect(validateTenantCron("*/2 * * * *").ok).toBe(false)
    expect(validateTenantCron("58,2 * * * *").ok).toBe(false) // 58 -> 02 next hour = 4 min
    expect(validateTenantCron("*/5 * * * *").ok).toBe(true)
    expect(validateTenantCron("0,30 9 * * *").ok).toBe(true)
  })
})

describe("next run in tenant timezone", () => {
  it("interprets the schedule in the tenant zone", () => {
    expect(iso(nextRunAt("0 9 * * *", "Asia/Kolkata", new Date("2027-01-10T00:00:00Z")))).toBe("2027-01-10T03:30:00.000Z")
    expect(iso(nextRunAt("0 9 * * *", "America/New_York", new Date("2027-01-10T00:00:00Z")))).toBe("2027-01-10T14:00:00.000Z")
  })
  it("is strictly after the cursor", () => {
    expect(iso(nextRunAt("0 9 * * *", "UTC", new Date("2027-01-10T09:00:00Z")))).toBe("2027-01-11T09:00:00.000Z")
  })
  it("honours weekday and Vixie day-or-weekday semantics", () => {
    // 2027-01-10 is a Sunday
    expect(iso(nextRunAt("0 9 * * 1-5", "UTC", NOW))).toBe("2027-01-11T09:00:00.000Z")
    expect(iso(nextRunAt("0 9 15 * 1", "UTC", NOW))).toBe("2027-01-11T09:00:00.000Z")
  })
  it("respects start and end bounds", () => {
    const startAt = new Date("2027-02-01T00:00:00Z")
    expect(iso(nextRunAt("0 9 * * *", "UTC", NOW, { startAt }))).toBe("2027-02-01T09:00:00.000Z")
    expect(nextRunAt("0 9 * * *", "UTC", NOW, { endAt: new Date("2027-01-10T08:00:00Z") })).toBeNull()
  })
  it("finds rare dates such as Feb 29", () => {
    expect(iso(nextRunAt("0 0 29 2 *", "UTC", NOW))).toBe("2028-02-29T00:00:00.000Z")
  })
})

describe("DST changes", () => {
  const zone = "America/New_York"
  it("spring-forward: a skipped wall time runs once, shifted by the gap", () => {
    // 2027-03-14 02:00 EST -> 03:00 EDT. 02:30 does not exist.
    expect(instantsForWallTime({ year: 2027, month: 3, day: 14, hour: 2, minute: 30 }, zone).gap).toBe(true)
    const runs = nextRunTimes("30 2 * * *", zone, new Date("2027-03-13T00:00:00Z"), 3)
    expect(runs.map(iso)).toEqual([
      "2027-03-13T07:30:00.000Z", // 02:30 EST
      "2027-03-14T07:30:00.000Z", // 03:30 EDT (shifted)
      "2027-03-15T06:30:00.000Z", // 02:30 EDT
    ])
  })
  it("fall-back: a repeated wall time runs once at the first occurrence", () => {
    // 2027-11-07 02:00 EDT -> 01:00 EST. 01:30 happens twice.
    expect(instantsForWallTime({ year: 2027, month: 11, day: 7, hour: 1, minute: 30 }, zone).instants).toHaveLength(2)
    const runs = nextRunTimes("30 1 * * *", zone, new Date("2027-11-06T12:00:00Z"), 2)
    expect(runs.map(iso)).toEqual(["2027-11-07T05:30:00.000Z", "2027-11-08T06:30:00.000Z"])
  })
  it("fall-back: hourly jobs keep cadence through both occurrences", () => {
    const runs = nextRunTimes("0 * * * *", zone, new Date("2027-11-07T04:30:00Z"), 3)
    expect(runs.map(iso)).toEqual(["2027-11-07T05:00:00.000Z", "2027-11-07T06:00:00.000Z", "2027-11-07T07:00:00.000Z"])
  })
  it("spring-forward: hourly jobs do not double-fire", () => {
    const runs = nextRunTimes("0 * * * *", zone, new Date("2027-03-14T05:30:00Z"), 3)
    expect(runs.map(iso)).toEqual(["2027-03-14T06:00:00.000Z", "2027-03-14T07:00:00.000Z", "2027-03-14T08:00:00.000Z"])
  })
  it("handles the southern hemisphere and half-hour zones", () => {
    // Sydney DST ends 2027-04-04 03:00 AEDT -> 02:00 AEST
    const runs = nextRunTimes("30 2 * * *", "Australia/Sydney", new Date("2027-04-02T00:00:00Z"), 3)
    expect(runs).toHaveLength(3)
    expect(new Set(runs.map((d) => d.toISOString().slice(0, 10))).size).toBe(3)
    expect(iso(nextRunAt("0 9 * * *", "Asia/Kolkata", new Date("2027-03-14T00:00:00Z")))).toBe("2027-03-14T03:30:00.000Z")
  })
})

describe("input validation", () => {
  it("accepts a preset and converts start/end from the job timezone", () => {
    const r = validateTenantJobInput({ ...base, startAt: "2027-02-01T00:00", endAt: "2027-12-31T23:59", notifyEmails: "a@x.com, A@x.com" }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.cronExpression).toBe("0 9 * * *")
    expect(r.value.startAt?.toISOString()).toBe("2027-02-01T05:00:00.000Z")
    expect(r.value.notifyEmails).toEqual(["a@x.com"])
    expect(r.value.maxAttempts).toBe(3)
  })
  it("ignores a client cron when a preset is selected", () => {
    const r = validateTenantJobInput({ ...base, cronExpression: "* * * * *" }, NOW)
    expect(r.ok && r.value.cronExpression).toBe("0 9 * * *")
  })
  it("rejects unknown actions, bad params, zones, windows and emails", () => {
    const r = validateTenantJobInput({
      name: "",
      actionKey: "shell.exec",
      timezone: "Mars/Olympus",
      presetKey: "custom",
      cronExpression: "* * * * *",
      maxAttempts: 9,
      notifyEmails: ["nope"],
    }, NOW)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(Object.keys(r.errors).sort()).toEqual(["actionKey", "cronExpression", "maxAttempts", "name", "notifyEmails", "timezone"])
  })
  it("rejects end before start and past end dates", () => {
    const a = validateTenantJobInput({ ...base, startAt: "2027-03-01T00:00", endAt: "2027-02-01T00:00" }, NOW)
    const b = validateTenantJobInput({ ...base, endAt: "2026-01-01T00:00" }, NOW)
    expect(!a.ok && a.errors.endAt).toBeTruthy()
    expect(!b.ok && b.errors.endAt).toBeTruthy()
  })
  it("rejects windows with no future run", () => {
    const r = validateTenantJobInput({ ...base, presetKey: "custom", cronExpression: "0 9 30 2 *" }, NOW)
    expect(!r.ok && r.errors.cronExpression).toMatch(/no future runs/)
  })
})

describe("scheduler tick planning", () => {
  const state = {
    enabled: true,
    nextRunAt: new Date("2027-01-10T09:00:00Z"),
    startAt: null,
    endAt: null,
    cronExpression: "0 9 * * *",
    timezone: "UTC",
    tenantStatus: "active",
  }
  it("dispatches a due slot and advances", () => {
    const plan = planTenantJobTick(state, new Date("2027-01-10T09:00:20Z"))
    expect(plan.kind).toBe("dispatch")
    if (plan.kind === "wait") return
    expect(iso(plan.slot)).toBe("2027-01-10T09:00:00.000Z")
    expect(iso(plan.nextRunAt)).toBe("2027-01-11T09:00:00.000Z")
  })
  it("a duplicate tick after the slot was advanced waits", () => {
    const first = planTenantJobTick(state, new Date("2027-01-10T09:00:20Z"))
    if (first.kind === "wait") throw new Error("expected dispatch")
    const second = planTenantJobTick({ ...state, nextRunAt: first.nextRunAt }, new Date("2027-01-10T09:00:40Z"))
    expect(second.kind).toBe("wait")
  })
  it("collapses missed slots into one run", () => {
    const plan = planTenantJobTick(state, new Date("2027-01-15T12:00:00Z"))
    expect(plan.kind === "dispatch" && iso(plan.nextRunAt)).toBe("2027-01-16T09:00:00.000Z")
  })
  it("skips (without dispatch) for disabled tenants but keeps advancing", () => {
    const plan = planTenantJobTick({ ...state, tenantStatus: "suspended" }, new Date("2027-01-10T09:00:20Z"))
    expect(plan).toMatchObject({ kind: "skip", skipReason: "tenant_disabled" })
  })
  it("waits for disabled schedules and future slots", () => {
    expect(planTenantJobTick({ ...state, enabled: false }, new Date("2027-01-10T10:00:00Z")).kind).toBe("wait")
    expect(planTenantJobTick(state, new Date("2027-01-10T08:59:59Z")).kind).toBe("wait")
  })
  it("ends the schedule after its end date", () => {
    const plan = planTenantJobTick({ ...state, endAt: new Date("2027-01-10T09:30:00Z") }, new Date("2027-01-10T09:00:10Z"))
    expect(plan.kind === "dispatch" && plan.nextRunAt).toBeNull()
  })
})

describe("failed retries", () => {
  it("transient action errors retry until attempts are exhausted, then dead-letter", () => {
    const kind = classifyJobFailure(new TenantJobError("Export store busy", "transient"))
    expect(kind).toBe("transient")
    expect(retryDisposition(kind, 1, 3)).toBe("queued")
    expect(retryDisposition(kind, 2, 3)).toBe("queued")
    expect(retryDisposition(kind, 3, 3)).toBe("dead_letter")
  })
  it("permanent action errors dead-letter immediately", () => {
    const kind = classifyJobFailure(new TenantJobError("Report schedule was deleted"))
    expect(kind).toBe("permanent")
    expect(retryDisposition(kind, 1, 5)).toBe("dead_letter")
  })
  it("maps queue state to tenant-facing run status", () => {
    expect(displayRunStatus("dispatched", "queued", 1)).toBe("retrying")
    expect(displayRunStatus("dispatched", "queued", 0)).toBe("queued")
    expect(displayRunStatus("failed", "dead_letter", 3)).toBe("dead_letter")
    expect(displayRunStatus("skipped", null, 0)).toBe("skipped")
    expect(displayRunStatus("pending", null, 0)).toBe("pending")
  })
})
