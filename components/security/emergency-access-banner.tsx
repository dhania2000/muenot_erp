"use client"

import { useState, useTransition } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { ShieldAlert } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"

type ActiveGrant = {
  id: number
  scope: string
  expiresAt: string
}

function toMs(value: string): number {
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z")
  return d.getTime()
}

function formatRemaining(expiresMs: number) {
  const ms = Math.max(0, expiresMs - Date.now())
  const mins = Math.floor(ms / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  return `${mins}m ${secs.toString().padStart(2, "0")}s`
}

/**
 * SPEC 65 — persistent, app-wide banner shown whenever the signed-in user has
 * an active, server-enforced break-glass grant. Mounted once in the workspace
 * layout so it appears on every page while elevated ("no silent usage"). Reads
 * live state from /api/security/emergency-access/active and lets the user end
 * their own access, which reverts the elevation server-side.
 */
export function EmergencyAccessBanner() {
  const { data, mutate } = useSWR<{ active: ActiveGrant[] }>(
    "/api/security/emergency-access/active",
    fetcher,
    { refreshInterval: 5000 },
  )
  const [isPending, startTransition] = useTransition()
  // Re-render every second for the live countdown.
  const [, setTick] = useState(0)
  useSWR("emergency-banner-tick", () => null, {
    refreshInterval: 1000,
    onSuccess: () => setTick((t) => t + 1),
  })

  const active = data?.active?.[0]
  if (!active) return null
  const expiresMs = toMs(active.expiresAt)

  function endAccess(id: number) {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/security/emergency-access/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "revoke", reason: "Ended by user from banner" }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? "Request failed")
        }
        await mutate()
        toast.success("Emergency access ended")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to end access")
      }
    })
  }

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive-foreground"
    >
      <div className="flex items-center gap-2 text-destructive">
        <ShieldAlert className="size-4 shrink-0" aria-hidden />
        <span className="font-semibold">EMERGENCY ACCESS ACTIVE</span>
        <span className="text-destructive/80">
          Scope: {active.scope} · Expires in {formatRemaining(expiresMs)}
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={isPending}
        className="border-destructive/40 text-destructive hover:bg-destructive/10"
        onClick={() => endAccess(active.id)}
      >
        Exit / end access
      </Button>
    </div>
  )
}
