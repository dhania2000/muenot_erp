"use client"

import { useEffect, useRef } from "react"
import { IDLE_GRACE_MS, type IdleStatus } from "@/lib/attendance-idle-config"

// ---------------------------------------------------------------------------
// Tracks "no activity" time while an employee is clocked in.
//
// "No activity" means the employee is not interacting with the screen at all —
// no mouse, keyboard, touch, wheel or scroll input — which also covers the tab
// being hidden, minimised or another app being in front (those simply produce
// no input events).
//
// IMPORTANT — what gets reported (see lib/attendance-idle-config.ts for the
// single source of truth on the grace length):
//   * IDLE is the TOTAL no-activity time. Once a continuous inactivity stretch
//     crosses the grace window we start reporting it, and we count the FULL
//     stretch — including the first IDLE_GRACE_MS — as idle time. Short gaps
//     below the grace window are treated as noise and never reported.
//   * BREAK is derived from idle, not reported separately: at clock-out the
//     server subtracts the grace once (Break = Idle - grace). This keeps the
//     two values distinct: e.g. 19 min of idle → Idle 19, Break 9.
//
// Idle is accrued continuously (roughly once a minute) so it reaches the server
// well before clock-out. This is a best-effort client heuristic and renders
// nothing.
// ---------------------------------------------------------------------------

/** How often we check for crossing the grace window / accrue idle minutes. */
const CHECK_INTERVAL_MS = 30 * 1000
/** How often we recompute the live Active / Idle / On Break status for the UI. */
const STATUS_INTERVAL_MS = 5 * 1000
const IDLE_ENDPOINT = "/api/hr/attendance/idle"

export function AttendanceIdleTracker({
  active,
  onStatusChange,
}: {
  active: boolean
  /** Fired whenever the live status changes, for an optional UI indicator. */
  onStatusChange?: (status: IdleStatus) => void
}) {
  const lastActivityRef = useRef<number>(Date.now())
  // Timestamp up to which idle time in the current inactivity stretch has been
  // reported. null means we are not in a reportable idle stretch yet.
  const idleReportedRef = useRef<number | null>(null)
  const statusRef = useRef<IdleStatus>("active")

  useEffect(() => {
    if (!active || typeof document === "undefined") {
      lastActivityRef.current = Date.now()
      idleReportedRef.current = null
      if (statusRef.current !== "active") {
        statusRef.current = "active"
        onStatusChange?.("active")
      }
      return
    }

    const setStatus = (next: IdleStatus) => {
      if (statusRef.current === next) return
      statusRef.current = next
      onStatusChange?.(next)
    }

    const report = (elapsedMs: number, useBeacon = false) => {
      const minutes = elapsedMs / 60000
      if (minutes < 1) return
      const payload = JSON.stringify({ minutes })
      if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon(IDLE_ENDPOINT, new Blob([payload], { type: "application/json" }))
        return
      }
      void fetch(IDLE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {})
    }

    // Bank any idle time accrued but not yet reported for the current stretch.
    const flushIdle = (useBeacon = false) => {
      if (idleReportedRef.current !== null) {
        report(Date.now() - idleReportedRef.current, useBeacon)
        idleReportedRef.current = null
      }
    }

    const onActivity = () => {
      // Returning to the screen ends the idle stretch: bank the remaining idle,
      // then restart the inactivity clock from now. Any tracked activity event
      // resets the timer, so duplicate/simultaneous events are harmless — they
      // all collapse into the same "now".
      flushIdle()
      lastActivityRef.current = Date.now()
      setStatus("active")
    }

    // Detect crossing the grace-window inactivity threshold and, once crossed,
    // accrue TOTAL idle minutes continuously so they reach the server before
    // clock-out. The first crossing reports the whole stretch so far (including
    // the grace period) as idle — the grace is only ever removed once, later,
    // when the server turns idle into break.
    const tick = () => {
      const now = Date.now()
      const idleElapsed = now - lastActivityRef.current
      if (idleElapsed < IDLE_GRACE_MS) return
      if (idleReportedRef.current === null) {
        report(idleElapsed)
        idleReportedRef.current = now
      } else {
        const delta = now - idleReportedRef.current
        if (delta >= 60000) {
          report(delta)
          idleReportedRef.current = now
        }
      }
    }

    // Lightweight, more frequent pass that only updates the live status badge
    // (Active / Idle / On Break) — independent of the idle-accrual cadence
    // above so the UI feels responsive without changing how idle minutes are
    // calculated or reported.
    const statusTick = () => {
      const idleMs = Date.now() - lastActivityRef.current
      if (idleMs < STATUS_INTERVAL_MS) setStatus("active")
      else if (idleMs < IDLE_GRACE_MS) setStatus("idle")
      else setStatus("break")
    }

    const onVisibility = () => {
      if (!document.hidden) onActivity()
    }
    const onPageHide = () => flushIdle(true)

    const activityEvents: (keyof WindowEventMap)[] = [
      "mousemove",
      "mousedown",
      "keydown",
      "wheel",
      "touchstart",
      "pointerdown",
      "scroll",
    ]
    activityEvents.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", onActivity)
    window.addEventListener("pagehide", onPageHide)
    const interval = setInterval(tick, CHECK_INTERVAL_MS)
    const statusInterval = setInterval(statusTick, STATUS_INTERVAL_MS)

    return () => {
      // Flush any in-progress idle when the session ends or we unmount.
      flushIdle()
      activityEvents.forEach((e) => window.removeEventListener(e, onActivity))
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onActivity)
      window.removeEventListener("pagehide", onPageHide)
      clearInterval(interval)
      clearInterval(statusInterval)
    }
  }, [active, onStatusChange])

  return null
}
