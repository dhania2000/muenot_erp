"use client"

import { useEffect, useRef } from "react"

// ---------------------------------------------------------------------------
// Tracks continuous "no activity" time while an employee is clocked in.
//
// "No activity" means the employee is not interacting with the screen at all —
// no mouse, keyboard, touch, wheel or scroll input — which also covers the tab
// being hidden, minimised or another app being in front (those simply produce
// no input events). Once inactivity passes the 15-minute grace window, every
// further minute — from the 15-minute mark until activity resumes — is reported
// to the idle endpoint, which reclassifies it from worked hours into break at
// clock-out. The first 15 minutes are always treated as work.
//
// Break time is accrued continuously (roughly once a minute) so it is recorded
// on the server well before clock-out, rather than only when the employee comes
// back. This is a best-effort client heuristic and renders nothing.
// ---------------------------------------------------------------------------

/** Inactivity below this is always counted as work — only time past it breaks. */
const IDLE_GRACE_MS = 15 * 60 * 1000 // 15 minutes
/** How often we check for crossing the grace window / accrue break minutes. */
const CHECK_INTERVAL_MS = 30 * 1000
const IDLE_ENDPOINT = "/api/hr/attendance/idle"

export function AttendanceIdleTracker({ active }: { active: boolean }) {
  const lastActivityRef = useRef<number>(Date.now())
  // Start of the not-yet-reported break stretch (at or after the grace mark).
  // Doubles as the "last reported" marker once we begin accruing.
  const breakStartRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active || typeof document === "undefined") {
      lastActivityRef.current = Date.now()
      breakStartRef.current = null
      return
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

    // Bank any break time accrued past the grace window and reset the marker.
    const flushBreak = (useBeacon = false) => {
      if (breakStartRef.current !== null) {
        report(Date.now() - breakStartRef.current, useBeacon)
        breakStartRef.current = null
      }
    }

    const onActivity = () => {
      // Returning to the screen ends the idle stretch: bank the break past the
      // grace mark, then restart the inactivity clock from now.
      flushBreak()
      lastActivityRef.current = Date.now()
    }

    // Detect crossing the 15-minute inactivity threshold and, once crossed,
    // accrue break minutes continuously so they reach the server before
    // clock-out. The break start is pinned to the grace boundary so only time
    // from the 15-minute mark onward is ever counted.
    const tick = () => {
      const now = Date.now()
      if (breakStartRef.current === null) {
        if (now - lastActivityRef.current < IDLE_GRACE_MS) return
        breakStartRef.current = lastActivityRef.current + IDLE_GRACE_MS
      }
      const elapsed = now - breakStartRef.current
      if (elapsed >= 60000) {
        report(elapsed)
        breakStartRef.current = now
      }
    }

    const onVisibility = () => {
      if (!document.hidden) onActivity()
    }
    const onPageHide = () => flushBreak(true)

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

    return () => {
      // Flush any in-progress break when the session ends or we unmount.
      flushBreak()
      activityEvents.forEach((e) => window.removeEventListener(e, onActivity))
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onActivity)
      window.removeEventListener("pagehide", onPageHide)
      clearInterval(interval)
    }
  }, [active])

  return null
}
