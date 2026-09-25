"use client"

import useSWR from "swr"
import { Wrench } from "lucide-react"

type PublicWindow = { id: number; scope: string; moduleKey: string | null; title: string; message: string; startsAt: string; endsAt: string | null }
type Lookup = { blocked: false; bypassing: PublicWindow | null; upcoming: PublicWindow[]; activeModules: string[] } | { blocked: true }

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : null))

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/** Spec28 (#125) — Announces upcoming windows and tells admins when they are bypassing one. */
export function MaintenanceBanner() {
  const { data } = useSWR<Lookup | null>("/api/maintenance", fetcher, { refreshInterval: 120_000 })
  if (!data || data.blocked) return null

  if (data.bypassing) {
    return (
      <div role="status" className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
        <Wrench className="size-4 shrink-0" aria-hidden="true" />
        <span>
          <strong className="font-medium">Maintenance in progress:</strong> {data.bypassing.title}. You have admin access; other users see the maintenance screen.
        </span>
      </div>
    )
  }

  const next = data.upcoming[0]
  if (!next) return null
  return (
    <div role="status" className="flex items-center gap-2 border-b border-sky-500/40 bg-sky-500/10 px-4 py-2 text-sm">
      <Wrench className="size-4 shrink-0" aria-hidden="true" />
      <span>
        <strong className="font-medium">Scheduled maintenance:</strong> {next.title} from {when(next.startsAt)}
        {next.endsAt ? ` to ${when(next.endsAt)}` : ""}. {next.message}
      </span>
    </div>
  )
}
