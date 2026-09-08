"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TicketCheck, Ticket, CircleDot, Clock3, CheckCircle2, Archive } from "lucide-react"

type TicketItem = {
  id: number
  subject: string
  type: string
  priority: "low" | "medium" | "high" | "urgent"
  status: "open" | "pending" | "resolved" | "closed"
  requester_name: string | null
  agent_name: string | null
  created_at: string
}

type ApiResponse = { tickets: TicketItem[]; canManage: boolean }

const STATUSES = ["open", "pending", "resolved", "closed"] as const
const PRIORITIES = ["urgent", "high", "medium", "low"] as const

const PRIORITY_STYLES: Record<string, string> = {
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  medium: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  high: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  urgent: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
}
const STATUS_STYLES: Record<string, string> = {
  open: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  resolved: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  closed: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

function formatDateTime(value: string) {
  const d = new Date(value.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function TicketOverview() {
  const { data, isLoading } = useSWR<ApiResponse>("/api/tickets", fetcher, { refreshInterval: 30000 })

  if (isLoading || !data) {
    return <div className="p-5 text-sm text-muted-foreground">Loading ticket dashboard…</div>
  }

  const tickets = data.tickets ?? []
  const canManage = data.canManage ?? false

  const byStatus = (s: string) => tickets.filter((t) => t.status === s).length
  const byPriority = (p: string) => tickets.filter((t) => t.priority === p).length

  const kpiCards = [
    { label: "Total Tickets", value: tickets.length, icon: Ticket },
    { label: "Open", value: byStatus("open"), icon: CircleDot },
    { label: "Pending", value: byStatus("pending"), icon: Clock3 },
    { label: "Resolved", value: byStatus("resolved"), icon: CheckCircle2 },
    { label: "Closed", value: byStatus("closed"), icon: Archive },
  ]

  const maxPriority = Math.max(1, ...PRIORITIES.map(byPriority))
  const recent = [...tickets]
    .sort((a, b) => new Date(b.created_at.replace(" ", "T")).getTime() - new Date(a.created_at.replace(" ", "T")).getTime())
    .slice(0, 8)

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
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
            <CardTitle className="text-base">Tickets by Priority</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {PRIORITIES.map((p) => {
              const count = byPriority(p)
              return (
                <div key={p} className="flex items-center gap-3">
                  <Badge variant="secondary" className={`w-20 justify-center font-normal capitalize ${PRIORITY_STYLES[p]}`}>{p}</Badge>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-foreground/70" style={{ width: `${(count / maxPriority) * 100}%` }} />
                  </div>
                  <span className="w-6 text-right text-sm tabular-nums text-muted-foreground">{count}</span>
                </div>
              )
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            {STATUSES.map((s) => (
              <div key={s} className="flex items-center justify-between rounded-lg border border-border p-3">
                <span className="text-sm capitalize text-muted-foreground">{s}</span>
                <Badge variant="secondary" className={`font-normal ${STATUS_STYLES[s]}`}>{byStatus(s)}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Tickets</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Ticket #</th>
                  <th className="px-4 py-2.5 font-medium">Subject</th>
                  {canManage && <th className="px-4 py-2.5 font-medium">Requester</th>}
                  <th className="px-4 py-2.5 font-medium">Priority</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr>
                    <td colSpan={canManage ? 6 : 5}>
                      <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                        <TicketCheck className="size-9" />
                        <p>No record found.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  recent.map((t) => (
                    <tr key={t.id} className="border-b last:border-b-0 hover:bg-muted/40">
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">#{t.id}</td>
                      <td className="px-4 py-3 font-medium">{t.subject}</td>
                      {canManage && <td className="px-4 py-3 text-muted-foreground">{t.requester_name || "—"}</td>}
                      <td className="px-4 py-3">
                        <Badge variant="secondary" className={`font-normal capitalize ${PRIORITY_STYLES[t.priority] ?? ""}`}>{t.priority}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary" className={`font-normal capitalize ${STATUS_STYLES[t.status] ?? ""}`}>{t.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDateTime(t.created_at)}</td>
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
