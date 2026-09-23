"use client"

import { useEffect } from "react"
import { IDLE_GRACE_MS, type IdleStatus } from "@/lib/attendance-idle-config"

type IdleWindow = { sessionId: string; startAt: number; endAt: number; ended: boolean }
type StoredState = { lastActivityAt: number; sessionId: string; pending: IdleWindow[] }
type TrackerProps = { active: boolean; trackingKey?: string | null; onStatusChange?: (status: IdleStatus) => void }

const PREFIX = "muenot:attendance-idle:"
let flushCurrentTracker: (() => Promise<boolean>) | null = null

function storageKey(key: string) { return `${PREFIX}${key}` }
function newSessionId() { return crypto.randomUUID() }

export async function flushAttendanceIdleBeforeClockOut(): Promise<boolean> {
  return flushCurrentTracker ? flushCurrentTracker() : true
}

export function clearAttendanceIdleTracking(key: string | null | undefined) {
  if (key && typeof window !== "undefined") localStorage.removeItem(storageKey(key))
}

function readState(key: string): StoredState {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(key)) || "null") as Partial<StoredState> | null
    if (saved && Number.isFinite(saved.lastActivityAt) && typeof saved.sessionId === "string" && Array.isArray(saved.pending)) {
      return { lastActivityAt: saved.lastActivityAt!, sessionId: saved.sessionId, pending: saved.pending }
    }
  } catch { /* Invalid local state starts a fresh tracking window. */ }
  return { lastActivityAt: Date.now(), sessionId: newSessionId(), pending: [] }
}

export function AttendanceIdleTracker({ active, trackingKey, onStatusChange }: TrackerProps) {
  useEffect(() => {
    if (!active || !trackingKey) {
      onStatusChange?.("active")
      return
    }

    const key = storageKey(trackingKey)
    const state = readState(trackingKey)
    let disposed = false
    let sending: Promise<boolean> | null = null
    let lastStoredAt = 0
    let lastHeartbeatAt = 0

    const persist = () => {
      try { localStorage.setItem(key, JSON.stringify(state)); lastStoredAt = Date.now() } catch { /* Storage may be unavailable. */ }
    }
    const send = async (window: IdleWindow): Promise<boolean> => {
      try {
        const response = await fetch("/api/hr/attendance/idle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: window.sessionId,
            startAt: new Date(window.startAt).toISOString(),
            endAt: new Date(window.endAt).toISOString(),
            ended: window.ended,
          }),
          keepalive: true,
        })
        return response.ok
      } catch { return false }
    }
    const drain = (): Promise<boolean> => {
      if (sending) return sending
      sending = (async () => {
        while (state.pending.length && !disposed) {
          if (!await send(state.pending[0])) return false
          state.pending.shift()
          persist()
        }
        return state.pending.length === 0
      })().finally(() => { sending = null })
      return sending
    }
    const finishWindow = (at: number) => {
      if (at - state.lastActivityAt > IDLE_GRACE_MS) {
        state.pending.push({ sessionId: state.sessionId, startAt: state.lastActivityAt, endAt: at, ended: true })
      }
      state.lastActivityAt = at
      state.sessionId = newSessionId()
      persist()
    }
    const updateStatus = () => {
      const elapsed = Date.now() - state.lastActivityAt
      onStatusChange?.(elapsed > IDLE_GRACE_MS ? "break" : elapsed >= 5_000 ? "idle" : "active")
    }
    const onActivity = () => {
      const now = Date.now()
      if (now - state.lastActivityAt > IDLE_GRACE_MS) {
        finishWindow(now)
        void drain()
      } else {
        state.lastActivityAt = now
        if (now - lastStoredAt > 1000) persist()
      }
      updateStatus()
    }
    const tick = () => {
      updateStatus()
      if (state.pending.length) void drain()
      const now = Date.now()
      if (now - state.lastActivityAt > IDLE_GRACE_MS && now - lastHeartbeatAt >= 30_000) {
        lastHeartbeatAt = now
        void send({ sessionId: state.sessionId, startAt: state.lastActivityAt, endAt: now, ended: false })
      }
    }
    const flush = async () => {
      finishWindow(Date.now())
      if (sending) await sending
      return drain()
    }
    flushCurrentTracker = flush
    persist()
    updateStatus()
    void drain()
    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "pointerdown", "scroll", "focus"] as const
    for (const event of events) window.addEventListener(event, onActivity, { passive: true })
    const visibility = () => { if (!document.hidden) onActivity() }
    document.addEventListener("visibilitychange", visibility)
    const interval = window.setInterval(tick, 5000)
    return () => {
      disposed = true
      if (flushCurrentTracker === flush) flushCurrentTracker = null
      for (const event of events) window.removeEventListener(event, onActivity)
      document.removeEventListener("visibilitychange", visibility)
      window.clearInterval(interval)
      persist()
    }
  }, [active, trackingKey, onStatusChange])

  return null
}
