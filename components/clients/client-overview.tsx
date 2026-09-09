"use client"

import { useMemo } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { ClientRow } from "@/components/clients/clients-client"
import { Users, UserCheck, UserX, ShieldCheck, BriefcaseBusiness } from "lucide-react"

type ApiResponse = { clients: ClientRow[] }

function formatDate(value: string) {
  const d = new Date(value.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function ClientOverview() {
  const { data, isLoading } = useSWR<ApiResponse>("/api/clients", fetcher, { refreshInterval: 30000 })

  const clients = useMemo(() => data?.clients ?? [], [data])

  const stats = useMemo(() => {
    const active = clients.filter((c) => c.status === "Active").length
    const inactive = clients.filter((c) => c.status === "Inactive").length
    const portal = clients.filter((c) => c.login_allowed === "Yes").length

    const categoryCounts = new Map<string, number>()
    for (const c of clients) {
      const key = c.category?.trim() || "Uncategorized"
      categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1)
    }
    const categories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)

    const recent = [...clients]
      .sort((a, b) => new Date(b.created_at.replace(" ", "T")).getTime() - new Date(a.created_at.replace(" ", "T")).getTime())
      .slice(0, 8)

    return { active, inactive, portal, categories, recent }
  }, [clients])

  if (isLoading || !data) {
    return <div className="p-5 text-sm text-muted-foreground">Loading client dashboard…</div>
  }

  const kpiCards = [
    { label: "Total Clients", value: clients.length, icon: Users },
    { label: "Active", value: stats.active, icon: UserCheck },
    { label: "Inactive", value: stats.inactive, icon: UserX },
    { label: "Portal Access", value: stats.portal, icon: ShieldCheck },
  ]

  const maxCategory = Math.max(1, ...stats.categories.map(([, count]) => count))

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpiCards.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-2 pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <k.icon className="size-4 text-muted-foreground" />
              </div>
              <span className="text-2xl font-semibold tracking-tight">{k.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Clients by Category</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {stats.categories.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No record found.</p>
            ) : (
              stats.categories.map(([label, count]) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-28 truncate text-sm text-muted-foreground" title={label}>
                    {label}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-foreground/70" style={{ width: `${(count / maxCategory) * 100}%` }} />
                  </div>
                  <span className="w-6 text-right text-sm tabular-nums text-muted-foreground">{count}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <span className="text-sm text-muted-foreground">Active</span>
              <Badge variant="secondary" className="bg-emerald-100 font-normal text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                {stats.active}
              </Badge>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <span className="text-sm text-muted-foreground">Inactive</span>
              <Badge variant="secondary" className="bg-slate-200 font-normal text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {stats.inactive}
              </Badge>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <span className="text-sm text-muted-foreground">Portal Enabled</span>
              <Badge variant="secondary" className="bg-sky-100 font-normal text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                {stats.portal}
              </Badge>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <span className="text-sm text-muted-foreground">Portal Disabled</span>
              <Badge variant="secondary" className="bg-amber-100 font-normal text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {clients.length - stats.portal}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Clients</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Client</th>
                  <th className="px-4 py-2.5 font-medium">Company</th>
                  <th className="px-4 py-2.5 font-medium">Category</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Added</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                        <BriefcaseBusiness className="size-9" />
                        <p>No record found.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  stats.recent.map((c) => (
                    <tr key={c.id} className="border-b last:border-b-0 hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <div className="flex flex-col">
                          <span className="font-medium">
                            {c.salutation ? `${c.salutation} ` : ""}
                            {c.client_name}
                          </span>
                          <span className="text-xs text-muted-foreground">{c.client_code}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{c.company_name || "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{c.category || "—"}</td>
                      <td className="px-4 py-3">
                        <Badge variant={c.status === "Active" ? "default" : "destructive"} className="font-normal">
                          {c.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(c.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
