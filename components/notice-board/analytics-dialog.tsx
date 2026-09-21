"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Loader2, Check, Clock } from "lucide-react"
import { formatDateTime } from "./shared"

type AnalyticsResponse = {
  heading: string
  acknowledgement_required: boolean
  summary: {
    totalRecipients: number
    read: number
    unread: number
    acknowledged: number
    pending: number
    emailSent: number
    emailFailed: number
    inAppSent: number
  }
  recipients: {
    id: number
    employee_name: string
    department: string | null
    designation: string | null
    read_at: string | null
    acknowledged_at: string | null
  }[]
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

export function AnalyticsDialog({
  noticeId, open, onOpenChange,
}: {
  noticeId: number | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { data, isLoading } = useSWR<AnalyticsResponse>(
    open && noticeId != null ? `/api/notice-board/${noticeId}/analytics` : null,
    fetcher,
  )

  const s = data?.summary
  const readPct = s && s.totalRecipients ? Math.round((s.read / s.totalRecipients) * 100) : 0
  const ackPct = s && s.totalRecipients ? Math.round((s.acknowledged / s.totalRecipients) * 100) : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Notice Analytics</DialogTitle>
          <DialogDescription className="truncate">{data?.heading ?? "Read & acknowledgement tracking"}</DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="mr-2 size-5 animate-spin" /> Loading analytics…
          </div>
        ) : (
          <div className="max-h-[72vh] space-y-5 overflow-y-auto px-6 py-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Recipients" value={s!.totalRecipients} />
              <Stat label="Read" value={s!.read} sub={`${readPct}%`} />
              <Stat label="Unread" value={s!.unread} />
              <Stat label="Acknowledged" value={s!.acknowledged} sub={data.acknowledgement_required ? `${ackPct}%` : "N/A"} />
              <Stat label="Pending Ack" value={data.acknowledgement_required ? s!.pending : "—"} />
              <Stat label="In-App Sent" value={s!.inAppSent} />
              <Stat label="Email Sent" value={s!.emailSent} />
              <Stat label="Email Failed" value={s!.emailFailed} />
            </div>

            <div className="grid gap-3">
              <div>
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Read progress</span><span>{readPct}%</span>
                </div>
                <Progress value={readPct} />
              </div>
              {data.acknowledgement_required && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>Acknowledgement progress</span><span>{ackPct}%</span>
                  </div>
                  <Progress value={ackPct} />
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Employee</th>
                    <th className="px-3 py-2 font-medium">Department</th>
                    <th className="px-3 py-2 font-medium">Read</th>
                    {data.acknowledgement_required && <th className="px-3 py-2 font-medium">Acknowledged</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.recipients.length === 0 ? (
                    <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">No recipients yet.</td></tr>
                  ) : data.recipients.map((r) => (
                    <tr key={r.id} className="border-b last:border-b-0">
                      <td className="px-3 py-2">{r.employee_name}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.department ?? "—"}</td>
                      <td className="px-3 py-2">
                        {r.read_at ? (
                          <Badge className="gap-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" title={formatDateTime(r.read_at)}>
                            <Check className="size-3" /> Read
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1 font-normal"><Clock className="size-3" /> Unread</Badge>
                        )}
                      </td>
                      {data.acknowledgement_required && (
                        <td className="px-3 py-2">
                          {r.acknowledged_at ? (
                            <Badge className="gap-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" title={formatDateTime(r.acknowledged_at)}>
                              <Check className="size-3" /> Yes
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="gap-1 font-normal"><Clock className="size-3" /> Pending</Badge>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
