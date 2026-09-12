"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatDateTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CalendarClock, ChevronRight, Mail, MessageSquare, Phone, Users } from "lucide-react"

type Followup = {
  id: number
  lead_id: number
  lead_code: string
  company_name: string | null
  contact_person: string | null
  contact_number: string | null
  email: string | null
  lead_status: string
  channel: string | null
  purpose: string | null
  due_at: string
  assigned_to_name: string | null
  is_overdue: number
}

const CHANNEL_ICON: Record<string, typeof Phone> = {
  Call: Phone,
  Email: Mail,
  WhatsApp: MessageSquare,
  Meeting: Users,
}

export function FollowupsClient({ canManage }: { canManage: boolean }) {
  const [scope, setScope] = useState<"all" | "mine">("all")
  const { data, isLoading, mutate } = useSWR<{ followups: Followup[] }>(
    `/api/sales/followups?scope=${scope}`,
    fetcher,
    { refreshInterval: 60000 },
  )

  const followups = data?.followups ?? []

  const groups = useMemo(() => {
    const now = new Date()
    const startOfTomorrow = new Date(now)
    startOfTomorrow.setHours(0, 0, 0, 0)
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1)
    const endOfTomorrow = new Date(startOfTomorrow)
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 1)

    const overdue: Followup[] = []
    const today: Followup[] = []
    const tomorrow: Followup[] = []
    const later: Followup[] = []

    for (const f of followups) {
      const due = new Date(f.due_at.replace(" ", "T"))
      if (due < now) overdue.push(f)
      else if (due < startOfTomorrow) today.push(f)
      else if (due < endOfTomorrow) tomorrow.push(f)
      else later.push(f)
    }
    return { overdue, today, tomorrow, later }
  }, [followups])

  async function update(id: number, action: "complete" | "cancel") {
    const res = await fetch(`/api/sales/followups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    })
    if (res.ok) {
      toast.success(action === "cancel" ? "Follow-up cancelled" : "Follow-up completed")
      mutate()
    } else {
      toast.error("Unable to update follow-up")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant={scope === "all" ? "default" : "outline"} onClick={() => setScope("all")}>
            All follow-ups
          </Button>
          <Button size="sm" variant={scope === "mine" ? "default" : "outline"} onClick={() => setScope("mine")}>
            Assigned to me
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="destructive">{groups.overdue.length} overdue</Badge>
          <Badge variant="secondary">{groups.today.length} today</Badge>
          <Badge variant="outline">{followups.length} open</Badge>
        </div>
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading follow-ups...</div>
      ) : followups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <CalendarClock className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No open follow-ups</p>
            <p className="text-sm text-muted-foreground">Scheduled reminders will show up here.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <FollowupGroup
            title="Overdue"
            tone="destructive"
            rows={groups.overdue}
            canManage={canManage}
            onUpdate={update}
          />
          <FollowupGroup title="Today" tone="default" rows={groups.today} canManage={canManage} onUpdate={update} />
          <FollowupGroup
            title="Tomorrow"
            tone="muted"
            rows={groups.tomorrow}
            canManage={canManage}
            onUpdate={update}
          />
          <FollowupGroup title="Later" tone="muted" rows={groups.later} canManage={canManage} onUpdate={update} />
        </div>
      )}
    </div>
  )
}

function FollowupGroup({
  title,
  tone,
  rows,
  canManage,
  onUpdate,
}: {
  title: string
  tone: "destructive" | "default" | "muted"
  rows: Followup[]
  canManage: boolean
  onUpdate: (id: number, action: "complete" | "cancel") => void
}) {
  if (rows.length === 0) return null
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          <span
            className={
              tone === "destructive"
                ? "text-destructive"
                : tone === "default"
                  ? "text-foreground"
                  : "text-muted-foreground"
            }
          >
            {title}
          </span>
        </CardTitle>
        <Badge variant={tone === "destructive" ? "destructive" : "outline"}>{rows.length}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.map((f) => {
          const Icon = CHANNEL_ICON[f.channel || ""] || CalendarClock
          return (
            <div
              key={f.id}
              className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={`/modules/sales/leads/${f.lead_id}`}
                    className="flex items-center gap-1 text-sm font-medium hover:underline"
                  >
                    {f.company_name || f.contact_person || f.lead_code}
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  </Link>
                  <span className="truncate text-sm text-muted-foreground">
                    {f.purpose || f.channel || "Follow-up"}
                    {f.contact_person ? ` · ${f.contact_person}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Due {formatDateTime(f.due_at)}
                    {f.assigned_to_name ? ` · ${f.assigned_to_name}` : ""}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {f.channel && <Badge variant="outline">{f.channel}</Badge>}
                {canManage && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => onUpdate(f.id, "complete")}>
                      Done
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onUpdate(f.id, "cancel")}>
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
