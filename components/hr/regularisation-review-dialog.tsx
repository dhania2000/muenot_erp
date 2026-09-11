"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatDate, formatTime } from "@/lib/attendance-ui"
import { Loader2 } from "lucide-react"

export type ReviewRequest = {
  id: number
  request_id: string
  employee_name: string
  employee_code: string
  work_date: string
  correction_type: string | null
  reason: string
  current_clock_in: string | null
  current_clock_out: string | null
  current_status: string | null
  requested_clock_in: string | null
  requested_clock_out: string | null
  requested_status: string | null
  attachment_path: string | null
  attachment_name: string | null
}

export function RegularisationReviewDialog({
  request,
  onClose,
  onReviewed,
}: {
  request: ReviewRequest | null
  onClose: () => void
  onReviewed: () => void
}) {
  const [rejectionReason, setRejectionReason] = useState("")
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null)

  async function act(action: "approve" | "reject") {
    if (!request) return
    if (action === "reject" && rejectionReason.trim().length < 3) {
      return toast.error("A rejection reason is required.")
    }
    setBusy(action)
    try {
      const r = await fetch("/api/hr/attendance-regularisation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: request.id, action, rejection_reason: action === "reject" ? rejectionReason.trim() : undefined }),
      })
      const json = await r.json()
      if (!r.ok) throw new Error(json.error || "Action failed")
      toast.success(action === "approve" ? "Approved — attendance updated" : "Request rejected")
      setRejectionReason("")
      onReviewed()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {request && (
          <>
            <DialogHeader>
              <DialogTitle>Review {request.request_id}</DialogTitle>
              <DialogDescription>
                {request.employee_name} ({request.employee_code}) · {formatDate(request.work_date)}
                {request.correction_type ? ` · ${request.correction_type}` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <ComparePanel
                  title="Current"
                  clockIn={request.current_clock_in}
                  clockOut={request.current_clock_out}
                  status={request.current_status}
                  tone="muted"
                />
                <ComparePanel
                  title="Requested"
                  clockIn={request.requested_clock_in}
                  clockOut={request.requested_clock_out}
                  status={request.requested_status}
                  tone="primary"
                />
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Reason</div>
                <p className="text-sm">{request.reason}</p>
              </div>

              {request.attachment_path && (
                <a
                  href={request.attachment_path}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex text-sm text-primary underline underline-offset-4"
                >
                  View attachment{request.attachment_name ? `: ${request.attachment_name}` : ""}
                </a>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="reject-reason">Rejection reason (required to reject)</Label>
                <Textarea
                  id="reject-reason"
                  rows={2}
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="Explain why this request is being rejected"
                />
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" disabled={busy !== null} onClick={() => act("reject")}>
                {busy === "reject" && <Loader2 className="size-4 animate-spin" />}
                Reject
              </Button>
              <Button disabled={busy !== null} onClick={() => act("approve")}>
                {busy === "approve" && <Loader2 className="size-4 animate-spin" />}
                Approve &amp; update attendance
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ComparePanel({
  title,
  clockIn,
  clockOut,
  status,
  tone,
}: {
  title: string
  clockIn: string | null
  clockOut: string | null
  status: string | null
  tone: "muted" | "primary"
}) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "primary" ? "border-primary/40 bg-primary/5" : "bg-muted/30"}`}>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <dl className="space-y-1 text-sm">
        <Row label="In" value={formatTime(clockIn)} />
        <Row label="Out" value={formatTime(clockOut)} />
        <Row label="Status" value={status || "—"} />
      </dl>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}
