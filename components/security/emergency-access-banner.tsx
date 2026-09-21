"use client"

import { useEffect, useState } from "react"
import { ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  expireStaleRequests,
  getActiveEmergencyRequest,
  revokeEmergencyRequest,
  subscribeEmergencyAccess,
  type EmergencyRequest,
} from "@/lib/emergency-access-store"

function formatRemaining(expiresAt: number) {
  const ms = Math.max(0, expiresAt - Date.now())
  const mins = Math.floor(ms / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  return `${mins}m ${secs.toString().padStart(2, "0")}s`
}

// SPEC 65 — persistent, reusable banner shown wherever emergency (break-glass)
// access is currently active for the signed-in user's browser session. Mount
// this once near the top of the admin/tenant layout so it appears on every
// page while active. Purely frontend state (see lib/emergency-access-store) —
// Codex will replace this with a real, server-enforced elevated session.
export function EmergencyAccessBanner() {
  const [active, setActive] = useState<EmergencyRequest | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    function refresh() {
      expireStaleRequests()
      setActive(getActiveEmergencyRequest())
    }
    refresh()
    const unsubscribe = subscribeEmergencyAccess(refresh)
    const interval = setInterval(() => {
      refresh()
      setTick((t) => t + 1)
    }, 1000)
    return () => {
      unsubscribe()
      clearInterval(interval)
    }
  }, [])

  if (!active || active.expiresAt === null) return null

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive-foreground"
    >
      <div className="flex items-center gap-2 text-destructive">
        <ShieldAlert className="size-4 shrink-0" aria-hidden />
        <span className="font-semibold">EMERGENCY ACCESS ACTIVE</span>
        <span className="text-destructive/80">
          Scope: {active.scope} · Expires in {formatRemaining(active.expiresAt)}
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="border-destructive/40 text-destructive hover:bg-destructive/10"
        onClick={() => revokeEmergencyRequest(active.id, "Ended by user")}
      >
        Exit / end access
      </Button>
    </div>
  )
}
