"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import { statusBadgeVariant } from "./leave-status"
import { CheckCircle2, XCircle, Clock, Ban, UserCheck } from "lucide-react"

const ICONS: Record<string, any> = {
  applied: Clock,
  manager_approve: UserCheck,
  manager_reject: XCircle,
  hr_approve: CheckCircle2,
  hr_reject: XCircle,
  cancel: Ban,
}

export function LeaveDetailDialog({
  requestId,
  onClose,
  onChanged,
}: {
  requestId: string | null
  onClose: () => void
  onChanged: () => void
}) {
  const { data, mutate, isLoading } = useSWR<any>(requestId ? `/api/hr/leave-requests/${requestId}` : null, fetcher)
  const [remarks, setRemarks] = useState("")
  const [busy, setBusy] = useState<string | null>(null)

  const request = data?.request
  const canManage = data?.canManage
  const isOwner = data?.isOwner
  const balance = data?.balance
  const status: string = request?.status || ""

  async function act(action: string) {
    if (!requestId) return
    setBusy(action)
    try {
      const res = await fetch(`/api/hr/leave-requests/${requestId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, remarks: remarks || null }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || "Action failed.")
        return
      }
      toast.success(`Request is now ${json.status}.`)
      setRemarks("")
      mutate()
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const showManagerActions = canManage && status === "Pending"
  const showHrActions = canManage && (status === "Pending" || status === "Manager Approved")
  const showCancel = (isOwner || canManage) && ["Pending", "Manager Approved", "HR Approved"].includes(status)

  return (
    <Dialog open={Boolean(requestId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {request?.request_id || "Leave request"}
            {status && <Badge variant={statusBadgeVariant(status)}>{status}</Badge>}
          </DialogTitle>
          <DialogDescription>
            {request ? `${request.employee_name}${request.department ? ` · ${request.department}` : ""}` : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !request ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <Detail label="Leave type" value={request.leave_type || request.leave_type_id} />
              <Detail label="From" value={String(request.from_date).slice(0, 10)} />
              <Detail label="To" value={String(request.to_date).slice(0, 10)} />
              <Detail label="Total days" value={String(request.days)} />
              <Detail label="Paid" value={String(request.paid_days ?? 0)} />
              <Detail label="LOP" value={String(request.lop_days ?? 0)} />
              {request.is_half_day ? <Detail label="Half day" value={request.half_day_session === "second" ? "Second half" : "First half"} /> : null}
              <Detail label="Applied" value={request.requested_at ? String(request.requested_at).slice(0, 10) : "—"} />
              <Detail label="Manager" value={request.manager_name || "—"} />
            </div>

            <div>
              <p className="text-xs font-medium uppercase text-muted-foreground">Reason</p>
              <p className="mt-1 text-sm">{request.reason}</p>
            </div>

            {request.attachment_url ? (
              <a href={request.attachment_url} target="_blank" rel="noreferrer" className="text-sm text-primary underline">
                View supporting document
              </a>
            ) : null}

            {balance ? (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="text-xs font-medium uppercase text-muted-foreground">Balance ({balance.year})</p>
                <p className="mt-1">
                  Available <span className="font-medium">{balance.available}</span> · Used {balance.used} · Pending {balance.pending} · Opening {balance.opening}
                </p>
              </div>
            ) : null}

            {Array.isArray(request.breakdown) && request.breakdown.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase text-muted-foreground">Day breakdown</p>
                <div className="flex flex-wrap gap-1">
                  {request.breakdown.map((d: any) => (
                    <span
                      key={d.date}
                      title={`${d.weekday} — ${d.reason}`}
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        d.counted > 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground line-through"
                      }`}
                    >
                      {d.date.slice(5)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <Separator />

            <div>
              <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">Timeline</p>
              <ol className="space-y-3">
                {(data?.timeline || []).map((t: any) => {
                  const Icon = ICONS[t.event_type] || Clock
                  return (
                    <li key={t.id} className="flex gap-3">
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div className="text-sm">
                        <p>{t.message}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.actor_name ? `${t.actor_name} · ` : ""}
                          {String(t.created_at).slice(0, 16).replace("T", " ")}
                        </p>
                      </div>
                    </li>
                  )
                })}
                {(!data?.timeline || data.timeline.length === 0) && (
                  <li className="text-sm text-muted-foreground">No events yet.</li>
                )}
              </ol>
            </div>

            {(showManagerActions || showHrActions || showCancel) && (
              <>
                <Separator />
                <div className="space-y-3">
                  <Textarea
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="Optional remarks for this decision…"
                    rows={2}
                  />
                  <div className="flex flex-wrap gap-2">
                    {showManagerActions && (
                      <>
                        <Button size="sm" onClick={() => act("manager_approve")} disabled={Boolean(busy)}>
                          Manager approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => act("manager_reject")} disabled={Boolean(busy)}>
                          Manager reject
                        </Button>
                      </>
                    )}
                    {showHrActions && (
                      <>
                        <Button size="sm" onClick={() => act("hr_approve")} disabled={Boolean(busy)}>
                          HR approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => act("hr_reject")} disabled={Boolean(busy)}>
                          HR reject
                        </Button>
                      </>
                    )}
                    {showCancel && (
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => act("cancel")} disabled={Boolean(busy)}>
                        Cancel request
                      </Button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-0.5">{value}</p>
    </div>
  )
}
