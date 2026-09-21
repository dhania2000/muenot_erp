"use client"

// SPEC 65 — frontend-only break-glass access store. There is no backend
// enforcement yet (see lib/platform-guard.ts — every request still goes
// through the standard role guard). This store only drives the UI: the
// persistent "Emergency access active" banner and the Emergency Access
// screen read and write the same browser-local state so they stay in sync
// without a global store dependency. Codex will replace this with real,
// server-enforced elevated sessions.

export type EmergencyStatus = "requested" | "approved" | "active" | "expired" | "revoked" | "rejected"

export type EmergencyRequest = {
  id: string
  requester: string
  scope: string
  justification: string
  durationMinutes: number
  approver: string
  notifySecurity: boolean
  status: EmergencyStatus
  startedAt: number | null
  expiresAt: number | null
  createdAt: number
  endedAt: number | null
  endReason?: string
}

const STORAGE_KEY = "muenot.emergency-access.v1"
const EVENT = "muenot:emergency-access-changed"

function read(): EmergencyRequest[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function write(records: EmergencyRequest[]) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* storage unavailable — state is best-effort only */
  }
}

export function subscribeEmergencyAccess(callback: () => void) {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(EVENT, callback)
  window.addEventListener("storage", callback)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener("storage", callback)
  }
}

export function listEmergencyRequests(): EmergencyRequest[] {
  return read().sort((a, b) => b.createdAt - a.createdAt)
}

export function getActiveEmergencyRequest(): EmergencyRequest | null {
  const now = Date.now()
  const active = read().find((r) => r.status === "active" && r.expiresAt !== null && r.expiresAt > now)
  return active ?? null
}

export function createEmergencyRequest(input: {
  requester: string
  scope: string
  justification: string
  durationMinutes: number
  approver: string
  notifySecurity: boolean
}): EmergencyRequest {
  const now = Date.now()
  const record: EmergencyRequest = {
    id: `EA-${now.toString(36).toUpperCase()}`,
    requester: input.requester,
    scope: input.scope,
    justification: input.justification,
    durationMinutes: input.durationMinutes,
    approver: input.approver,
    notifySecurity: input.notifySecurity,
    // Demo-only auto-approval so the frontend flow is fully exercisable
    // without a backend. Codex will replace this with a real approval step.
    status: "active",
    startedAt: now,
    expiresAt: now + input.durationMinutes * 60_000,
    createdAt: now,
    endedAt: null,
  }
  write([record, ...read()])
  return record
}

export function revokeEmergencyRequest(id: string, reason: string) {
  const now = Date.now()
  write(
    read().map((r) =>
      r.id === id ? { ...r, status: "revoked" as EmergencyStatus, endedAt: now, endReason: reason } : r,
    ),
  )
}

export function expireStaleRequests() {
  const now = Date.now()
  const records = read()
  const next = records.map((r) =>
    r.status === "active" && r.expiresAt !== null && r.expiresAt <= now
      ? { ...r, status: "expired" as EmergencyStatus, endedAt: r.expiresAt }
      : r,
  )
  if (JSON.stringify(next) !== JSON.stringify(records)) write(next)
}
