import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: vi.fn(), pool: {} }))

import { idleBreakSeconds, summarizeIdleWindows } from "@/lib/attendance-idle-sessions"

const MINUTE = 60_000
const interval = (minutes: number, startMs = 0) => ({ startMs, endMs: startMs + minutes * MINUTE })

describe("attendance inactivity grace per continuous session", () => {
  it.each([
    [5, 0], [10, 0], [15, 300], [40, 1800], [120, 6600],
  ])("%i minutes idle yields %i break seconds", (minutes, breakSeconds) => {
    expect(idleBreakSeconds(interval(minutes))).toBe(breakSeconds)
  })

  it("does not apply one grace period to the entire day", () => {
    expect(summarizeIdleWindows([interval(8), interval(7, 20 * MINUTE)])).toEqual({ idleSeconds: 900, breakSeconds: 0 })
    expect(summarizeIdleWindows([interval(15), interval(20, 30 * MINUTE)])).toEqual({ idleSeconds: 2100, breakSeconds: 900 })
  })

  it("keeps second-level precision at the threshold", () => {
    expect(idleBreakSeconds({ startMs: 0, endMs: 10 * MINUTE + 1000 })).toBe(1)
  })

  it("handles an interval crossing midnight", () => {
    const startMs = Date.parse("2026-09-22T23:55:00+05:30")
    expect(idleBreakSeconds(interval(20, startMs))).toBe(600)
  })
})
