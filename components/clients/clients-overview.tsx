"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Users,
  UserCheck,
  UserX,
  FileSignature,
  CalendarClock,
  BriefcaseBusiness,
} from "lucide-react"
import type { ClientRow } from "@/components/clients/clients-client"

type Contract = {
  id: number
  contract_code: string
  company_name: string
  start_date: string | null
  end_date: string | null
  value: number
  status: string
}

function parseDate(value: string | null) {
  if (!value) return null
  const d = new Date(value.replace(" ", "T"))
  return Number.isNaN(d.getTime()) ? null : d
}

function formatDate(value: string | null) {
  const d = parseDate(value)
  if (!d) return "—"
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function ClientsOverview() {
  const { data: clientData, isLoading: clientsLoading } = useSWR<{ clients: ClientRow[] }>(
    "/api/clients",
    fetcher,
  )
  const { data: contractData } = useSWR<{ contracts: Contract[] }>("/api/sales/contracts", fetcher)

  const clients = clientData?.clients ?? []
  const contracts = contractData?.contracts ?? []

  const total = clients.length
  const active = clients.filter((c) => c.status === "Active").length
  const inactive = clients.filter((c) => c.status === "Inactive").length

  const running = contracts.filter((c) => c.status === "Active").length

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
  const expiringThisMonth = contracts.filter((c) => {
    const end = parseDate(c.end_date)
    return end && end >= monthStart && end <= monthEnd
  }).length

  const newThisMonth = clients.filter((c) => {
    const created = parseDate(c.created_at)
    return created && created >= monthStart && created <= monthEnd
  }).length

  const kpiCards = [
    { label: "Total Clients", value: total, icon: Users },
    { label: "Active Clients", value: active, icon: UserCheck },
    { label: "Inactive Clients", value: inactive, icon: UserX },
    { label: "Contracts Running", value: running, icon: FileSignature },
    { label: "Expiring This Month", value: expiringThisMonth, icon: CalendarClock },
    { label: "New This Month", value: newThisMonth, icon: BriefcaseBusiness },
  ]

  const categoryCounts = clients.reduce<Record<string, number>>((acc, c) => {
    const key = c.category?.trim() || "Uncategorized"
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const categories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const maxCategory = Math.max(1, ...categories.map(([, n]) => n))

  const recent = [...clients]
    .sort((a, b) => (parseDate(b.created_at)?.getTime() ?? 0) - (parseDate(a.created_at)?.getTime() ?? 0))
    .slice(0, 8)

  const upcomingExpiry = [...contracts]
    .filter((c) => {
      const end = parseDate(c.end_date)
      return end && end >= now
    })
    .sort((a, b) => (parseDate(a.end_date)?.getTime() ?? 0) - (parseDate(b.end_date)?.getTime() ?? 0))
    .slice(0, 6)

  if (clientsLoading) {
    return <div className="p-5 text-sm text-muted-foreground">Loading client dashboard…</div>
  }

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
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
            {categories.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No clients yet.</p>
            ) : (
              categories.map(([name, count]) => (
                <div key={name} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-sm text-muted-foreground">{name}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-foreground/70"
                      style={{ width: `${(count / maxCategory) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 text-right text-sm tabular-nums text-muted-foreground">{count}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upcoming Contract Expiries</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Contract</th>
                    <th className="px-4 py-2.5 font-medium">Company</th>
                    <th className="px-4 py-2.5 font-medium">Ends</th>
                  </tr>
                </thead>
                <tbody>
                  {upcomingExpiry.length === 0 ? (
                    <tr>
                      <td colSpan={3}>
                        <div className="py-12 text-center text-sm text-muted-foreground">No upcoming expiries.</div>
                      </td>
                    </tr>
                  ) : (
                    upcomingExpiry.map((c) => (
                      <tr key={c.id} className="border-b last:border-b-0 hover:bg-muted/40">
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.contract_code}</td>
                        <td className="px-4 py-3 font-medium">{c.company_name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDate(c.end_date)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
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
                {recent.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                        <BriefcaseBusiness className="size-9" />
                        <p>No clients found.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  recent.map((c) => (
                    <tr key={c.id} className="border-b last:border-b-0 hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <div className="flex flex-col">
                          <span className="font-medium">
                            {c.salutation ? `${c.salutation} ` : ""}
                            {c.client_name}
                          </span>
                          <span className="text-xs text-muted-foreground">{c.email}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{c.company_name || "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{c.category || "—"}</td>
                      <td className="px-4 py-3">
                        <Badge variant={c.status === "Active" ? "default" : "destructive"}>{c.status}</Badge>
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
