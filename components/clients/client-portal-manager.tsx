"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ShieldCheck, Search, Users } from "lucide-react"
import { ClientPortalControls, type PortalUser } from "@/components/clients/client-portal-controls"
import type { ClientRow } from "@/components/clients/clients-client"
import { cn } from "@/lib/utils"

export function ClientPortalManager() {
  const { data, isLoading } = useSWR<{ clients: ClientRow[] }>("/api/clients", fetcher)
  // Portal logins across all clients, used to badge which clients already have
  // portal access provisioned.
  const usersReq = useSWR<{ users: PortalUser[] }>("/api/admin/portal/users", fetcher)

  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const clients = data?.clients ?? []

  const loginCountByClient = useMemo(() => {
    const map = new Map<number, number>()
    for (const u of usersReq.data?.users ?? []) {
      map.set(u.client_id, (map.get(u.client_id) ?? 0) + 1)
    }
    return map
  }, [usersReq.data])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return clients
    return clients.filter((c) =>
      [c.client_name, c.company_name, c.email, c.client_code]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    )
  }, [clients, search])

  const selected = clients.find((c) => c.id === selectedId) ?? null

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      {/* Client picker */}
      <aside className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients…"
            className="pl-9"
            aria-label="Search clients"
          />
        </div>

        <ScrollArea className="h-[60vh]">
          <ul className="grid gap-1 pr-2">
            {isLoading ? (
              <li className="px-2 py-3 text-sm text-muted-foreground">Loading clients…</li>
            ) : filtered.length === 0 ? (
              <li className="px-2 py-3 text-sm text-muted-foreground">No clients found.</li>
            ) : (
              filtered.map((c) => {
                const logins = loginCountByClient.get(c.id) ?? 0
                const isActive = c.id === selectedId
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                        isActive
                          ? "border-primary/50 bg-primary/10"
                          : "border-transparent hover:border-border hover:bg-muted/40",
                      )}
                    >
                      <span className="grid min-w-0 gap-0.5">
                        <span className="truncate text-sm font-medium">
                          {c.company_name || c.client_name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">{c.email}</span>
                      </span>
                      {logins > 0 ? (
                        <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
                          <Users className="size-3" />
                          {logins}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </ScrollArea>
      </aside>

      {/* Controls */}
      <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
        {selected ? (
          <div className="grid gap-4">
            <div className="flex items-center gap-2 border-b border-border pb-4">
              <ShieldCheck className="size-5 text-primary" />
              <div className="grid gap-0.5">
                <h2 className="text-base font-semibold">
                  {selected.company_name || selected.client_name}
                </h2>
                <p className="text-xs text-muted-foreground">
                  Control what this client can see and do in the portal, and manage their login accounts.
                </p>
              </div>
            </div>
            <ClientPortalControls client={selected} active />
          </div>
        ) : (
          <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-2 text-center">
            <ShieldCheck className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">Select a client</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Choose a client from the list to manage their portal access, login accounts and shared records.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
