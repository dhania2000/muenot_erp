"use client"

import { useEffect, useRef } from "react"

// ---------------------------------------------------------------------------
// Tracks continuous "away from screen" time while an employee is clocked in.
//
// "Away" means the tab is hidden (screen off, minimised, tab switched) or the
// window has lost focus (another app in front — "switch mode"). When an away
// stretch ends — or the page is unloaded — and it lasted longer than the grace
// window, the full duration is reported to the idle endpoint, which moves it
// from worked hours into break at clock-out.
//
// This is a best-effort client heuristic: browsers fire visibility/blur events
// on screen lock and app switching on the major platforms. Renders nothing.
// ---------------------------------------------------------------------------

const IDLE_GRACE_MS = 10 * 60 * 1000 // 10 minutes
const IDLE_ENDPOINT = "/api/hr/attendance/idle"

export function AttendanceIdleTracker({ active }: { active: boolean }) {
  const awayStartRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active || typeof document === "undefined") {
      awayStartRef.current = null
      return
    }

    const isPresent = () => !document.hidden && document.hasFocus()

    const report = (elapsedMs: number, useBeacon = false) => {
      const minutes = elapsedMs / 60000
      if (minutes < 10) return // only stretches longer than the grace window count
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

    const goAway = () => {
      if (awayStartRef.current === null) awayStartRef.current = Date.now()
    }

    const comeBack = () => {
      if (awayStartRef.current !== null) {
        const elapsed = Date.now() - awayStartRef.current
        awayStartRef.current = null
        report(elapsed)
      }
    }

    const onVisibility = () => {
      if (document.hidden) goAway()
      else if (isPresent()) comeBack()
    }
    const onBlur = () => goAway()
    const onFocus = () => {
      if (isPresent()) comeBack()
    }
    const onPageHide = () => {
      if (awayStartRef.current !== null) {
        report(Date.now() - awayStartRef.current, true)
        awayStartRef.current = null
      }
    }

    // If we mount already away (e.g. clocked in from a background tab).
    if (!isPresent()) goAway()

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onFocus)
    window.addEventListener("pagehide", onPageHide)

    return () => {
      // Flush any in-progress away stretch when the session ends or we unmount.
      comeBack()
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("pagehide", onPageHide)
    }
  }, [active])

  return null
}
