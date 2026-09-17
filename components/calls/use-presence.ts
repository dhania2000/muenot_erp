"use client"

import useSWR from "swr"

export type PresenceStatus = "online" | "offline" | "busy" | "dnd" | "in_call"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

/**
 * Live presence for a set of HR Employee Master ids. Polls the shared presence
 * endpoint (Phase 3/78/79) on a light interval — no aggressive polling.
 */
export function usePresence(employeeIds: number[]) {
  const key = employeeIds.length ? `/api/calls/presence?employeeIds=${employeeIds.join(",")}` : null
  const { data } = useSWR<{ presence: Record<string, PresenceStatus> }>(key, fetcher, {
    refreshInterval: 15000,
    revalidateOnFocus: true,
  })
  return (data?.presence || {}) as Record<string, PresenceStatus>
}

export const PRESENCE_META: Record<PresenceStatus, { label: string; dot: string }> = {
  online: { label: "Online", dot: "bg-emerald-500" },
  offline: { label: "Offline", dot: "bg-muted-foreground/40" },
  busy: { label: "Busy", dot: "bg-amber-500" },
  in_call: { label: "In call", dot: "bg-red-500" },
  dnd: { label: "Do Not Disturb", dot: "bg-red-500" },
}
