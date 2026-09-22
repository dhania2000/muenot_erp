"use client"

import { useEffect, useRef } from "react"
import { IDLE_GRACE_MS, type IdleStatus } from "@/lib/attendance-idle-config"

// ---------------------------------------------------------------------------
// Tracks continuous "no activity" time while an employee is clocked in.
//
// "No activity" means the employee is not interacting with the screen at all —
// no mouse, keyboard, touch, wheel or scroll input — which also covers the tab
// being hidden, minimised or another app being in front (those simply produce
// no input events).
//
// Every new continuous idle stretch gets its own grace period (see
// lib/attendance-idle-config.ts for the single source of truth on its length):
// the first IDLE_GRACE_MS of that stretch is always attendance/work time, and
// only the time from the grace boundary onward — until activity resumes — is
// ever reported to the idle endpoint, which reclassifies it from worked hours
// into break at clock-out. Any tracked activity event immediately ends the
// stretch and restarts the grace period from zero for the next one, so
// separate short idle periods are never combined together.
//
// Break time is accrued continuously (roughly once a minute) so it is recorded
// on the server well before clock-out, rather than only when the employee comes
// back. This is a best-effort client heuristic and renders nothing.
// ---------------------------------------------------------------------------

/** How often we check for crossing the grace window / accrue break minutes. */
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
  // Start of the not-yet-reported break stretch (at or after the grace mark).
  // Doubles as the "last reported" marker once we begin accruing.
  const breakStartRef = useRef<number | null>(null)
  const statusRef = useRef<IdleStatus>("active")

  useEffect(() => {
    if (!active || typeof document === "undefined") {
      lastActivityRef.current = Date.now()
      breakStartRef.current = null
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

    // Bank any break time accrued past the grace window and reset the marker.
    const flushBreak = (useBeacon = false) => {
      if (breakStartRef.current !== null) {
        report(Date.now() - breakStartRef.current, useBeacon)
        breakStartRef.current = null
      }
    }

    const onActivity = () => {
      // Returning to the screen ends the idle stretch: bank the break past the
      // grace mark, then restart the inactivity clock from now. Any tracked
      // activity event resets the timer, so duplicate/simultaneous events are
      // harmless — they all collapse into the same "now".
      flushBreak()
      lastActivityRef.current = Date.now()
      setStatus("active")
    }

    // Detect crossing the grace-window inactivity threshold and, once crossed,
    // accrue break minutes continuously so they reach the server before
    // clock-out. The break start is pinned to the grace boundary so only time
    // from the grace mark onward is ever counted — the timestamp-based math
    // (not the interval cadence) is what determines the split.
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

    // Lightweight, more frequent pass that only updates the live status badge
    // (Active / Idle / On Break) — independent of the break-accrual cadence
    // above so the UI feels responsive without changing how break minutes are
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
    const statusInterval = setInterval(statusTick, STATUS_INTERVAL_MS)

    return () => {
      // Flush any in-progress break when the session ends or we unmount.
      flushBreak()
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
