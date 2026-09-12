"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import { statusBadgeVariant, formatWindow, shiftTimeLabel } from "./shift-change-status"
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  Clock,
  FileText,
  Undo2,
  UserCheck,
  XCircle,
} from "lucide-react"

const ICONS: Record<string, any> = {
  created: Clock,
  approver_assigned: UserCheck,
  approve: CheckCircle2,
  assignment_created: FileText,
  reject: XCircle,
  withdraw: Undo2,
  cancel: Ban,
}

export function ShiftChangeDetailDialog({
  requestId,
  onClose,
  onChanged,
}: {
  requestId: string | null
  onClose: () => void
  onChanged: () => void
}) {
  const { data, mutate, isLoading } = useSWR<any>(
    requestId ? `/api/hr/shift-change-requests/${requestId}` : null,
    fetcher,
  )
  const [remarks, setRemarks] = useState("")
  const [override, setOverride] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const request = data?.request
  const currentShift = data?.currentShift
  const requestedShift = data?.requestedShift
  const conflicts = data?.conflicts
  const assignment = data?.assignment
  const teamOnRequestedShift: any[] = data?.teamOnRequestedShift || []
  const canManage = data?.canManage
  const canOverride = data?.canOverride
  const isOwner = data?.isOwner
  const status: string = request?.status || ""

  async function act(action: string) {
    if (!requestId) return
    if (action === "reject" && !remarks.trim()) {
      toast.error("A rejection reason is required.")
      return
    }
    setBusy(action)
    try {
      const res = await fetch(`/api/hr/shift-change-requests/${requestId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, remarks: remarks || null, override }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || "Action failed.")
        return
      }
      toast.success(`Request is now ${json.status}.`)
      setRemarks("")
      setOverride(false)
      mutate()
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const showApproveReject = canManage && status === "Pending"
  const showWithdraw = (isOwner || canManage) && status === "Pending"
  const showCancel =
    (status === "Pending" && (isOwner || canManage)) || (status === "Approved" && canManage)
  const hasActions = showApproveReject || showWithdraw || showCancel
  const hardConflicts = (conflicts?.errors?.length || 0) > 0

  return (
    <Dialog open={Boolean(requestId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-base">{request?.request_id || "Shift change"}</span>
            {status && <Badge variant={statusBadgeVariant(status)}>{status}</Badge>}
            {Boolean(Number(request?.is_override)) && <Badge variant="outline">Override</Badge>}
          </DialogTitle>
          <DialogDescription>
            {request
              ? `${request.employee_name}${request.department ? ` · ${request.department}` : ""}`
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !request ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5">
            {/* Current vs requested comparison */}
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Current shift</p>
                <p className="mt-1 font-medium">{currentShift?.shift_name || "Not assigned"}</p>
                <p className="text-sm text-muted-foreground">
                  {shiftTimeLabel(currentShift?.start_time, currentShift?.end_time, currentShift?.is_overnight)}
                </p>
              </div>
              <div className="hidden items-center justify-center sm:flex">
                <ArrowRight className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">Requested shift</p>
                <p className="mt-1 font-medium">{requestedShift?.shift_name || "—"}</p>
                <p className="text-sm text-muted-foreground">
                  {shiftTimeLabel(requestedShift?.start_time, requestedShift?.end_time, requestedShift?.is_overnight)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <Detail label="Type" value={request.change_type} />
              <Detail label="Window" value={formatWindow(request.change_type, request.from_date, request.to_date)} />
              <Detail label="Category" value={request.reason_category || "—"} />
              <Detail label="Approver" value={request.approver_name || "—"} />
              <Detail label="Requested" value={request.created_at ? String(request.created_at).slice(0, 10) : "—"} />
              <Detail label="Reviewed" value={request.reviewed_at ? String(request.reviewed_at).slice(0, 10) : "—"} />
            </div>

            <div>
              <p className="text-xs font-medium uppercase text-muted-foreground">Reason</p>
              <p className="mt-1 text-sm">{request.reason || "—"}</p>
            </div>

            {request.review_remarks ? (
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">Review remarks</p>
                <p className="mt-1 text-sm">{request.review_remarks}</p>
              </div>
            ) : null}

            {request.cancel_reason ? (
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">Cancellation reason</p>
                <p className="mt-1 text-sm">{request.cancel_reason}</p>
              </div>
            ) : null}

            {Boolean(Number(request.is_override)) && request.override_reason ? (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <p className="text-xs font-medium uppercase text-muted-foreground">Override justification</p>
                <p className="mt-1">{request.override_reason}</p>
              </div>
            ) : null}

            {request.attachment_url ? (
              <a
                href={request.attachment_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary underline"
              >
                <FileText className="h-3.5 w-3.5" />
                {request.attachment_name || "View attachment"}
              </a>
            ) : null}

            {assignment ? (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="text-xs font-medium uppercase text-muted-foreground">Linked shift assignment</p>
                <p className="mt-1 font-mono text-xs">{assignment.assignment_id}</p>
                <p className="text-muted-foreground">
                  Effective {String(assignment.effective_from).slice(0, 10)}
                  {assignment.effective_to ? ` → ${String(assignment.effective_to).slice(0, 10)}` : " onward"} ·{" "}
                  {assignment.status}
                </p>
              </div>
            ) : null}

            {/* Approver-only advisories */}
            {canManage && conflicts && (conflicts.errors.length || conflicts.warnings.length) ? (
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="mb-1.5 text-xs font-medium uppercase text-muted-foreground">Conflict check</p>
                <div className="space-y-1.5">
                  {conflicts.errors.map((m: string, i: number) => (
                    <p key={`e${i}`} className="flex items-start gap-1.5 text-xs text-destructive">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {m}
                    </p>
                  ))}
                  {conflicts.warnings.map((m: string, i: number) => (
                    <p key={`w${i}`} className="flex items-start gap-1.5 text-xs text-amber-600">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {m}
                    </p>
                  ))}
                </div>
              </div>
            ) : null}

            {canManage && teamOnRequestedShift.length > 0 ? (
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase text-muted-foreground">
                  Already on the requested shift
                </p>
                <div className="flex flex-wrap gap-1">
                  {teamOnRequestedShift.map((t: any) => (
                    <Badge key={t.employee_code} variant="secondary" className="font-normal">
                      {t.employee_name}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            <Separator />

            {/* Timeline */}
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

            {hasActions && (
              <>
                <Separator />
                <div className="space-y-3">
                  <Textarea
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="Remarks (required to reject)…"
                    rows={2}
                  />
                  {canOverride && showApproveReject && hardConflicts && (
                    <div className="flex items-center gap-2">
                      <Checkbox id="scr-detail-override" checked={override} onCheckedChange={(v) => setOverride(Boolean(v))} />
                      <Label htmlFor="scr-detail-override" className="cursor-pointer text-sm font-normal">
                        Override conflicts to approve
                      </Label>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {showApproveReject && (
                      <>
                        <Button size="sm" onClick={() => act("approve")} disabled={Boolean(busy) || (hardConflicts && !override)}>
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => act("reject")} disabled={Boolean(busy)}>
                          Reject
                        </Button>
                      </>
                    )}
                    {showWithdraw && (
                      <Button size="sm" variant="ghost" onClick={() => act("withdraw")} disabled={Boolean(busy)}>
                        Withdraw
                      </Button>
                    )}
                    {showCancel && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => act("cancel")}
                        disabled={Boolean(busy)}
                      >
                        {status === "Approved" ? "Cancel approved change" : "Cancel request"}
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
