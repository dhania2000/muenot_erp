"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import { EVENT_META, formatDays, formatDateTime } from "./leave-quota-format"

/**
 * Read-only ledger event inspector with a ledger-derived balance impact, the
 * real source record behind the reference, and a controlled reversal action
 * for authorized users. The original event is never mutated.
 */
export function LeaveQuotaDetailDialog({
  eventRef,
  onClose,
  onChanged,
}: {
  eventRef: string | null
  onClose: () => void
  onChanged: () => void
}) {
  const url = eventRef ? `/api/hr/leave-quota-history/detail?event=${encodeURIComponent(eventRef)}` : null
  const { data, isLoading, mutate } = useSWR<any>(url, fetcher)
  const [reason, setReason] = useState("")
  const [reversing, setReversing] = useState(false)
  const [showReverse, setShowReverse] = useState(false)

  const event = data?.event
  const impact = data?.balanceImpact
  const source = data?.source
  const reversedBy = data?.reversedBy
  const canManage = Boolean(data?.canManage)
  const meta = event ? EVENT_META[event.event_type] : undefined
  const canReverse = canManage && event && event.event_type !== "reversal" && !reversedBy

  async function reverse() {
    if (!event) return
    setReversing(true)
    try {
      const res = await fetch("/api/hr/leave-quota-history/reverse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: event.quota_event_id, reason: reason.trim() || undefined }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || "Could not reverse the event.")
        return
      }
      toast.success(`Reversal posted (${json.quota_event_id}).`)
      setShowReverse(false)
      setReason("")
      mutate()
      onChanged()
    } finally {
      setReversing(false)
    }
  }

  return (
    <Dialog open={Boolean(eventRef)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-base">{event?.quota_event_id || "Ledger event"}</span>
            {meta && <Badge className={meta.className}>{meta.label}</Badge>}
          </DialogTitle>
          <DialogDescription>Immutable ledger transaction. Corrections are posted as reversals.</DialogDescription>
        </DialogHeader>

        {isLoading || !event ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Field label="Employee">
                <div className="font-medium">{event.employee_name}</div>
                <div className="text-xs text-muted-foreground">
                  {event.employee_code}
                  {event.department ? ` · ${event.department}` : ""}
                  {event.designation ? ` · ${event.designation}` : ""}
                </div>
              </Field>
              <Field label="Leave type">
                {event.leave_type || "—"}
                {event.leave_type_code ? <span className="text-xs text-muted-foreground"> ({event.leave_type_code})</span> : null}
              </Field>
              <Field label="Year">{event.year}</Field>
              <Field label="Days">
                <span className={Number(event.days) < 0 ? "font-semibold text-destructive" : "font-semibold text-emerald-600"}>
                  {formatDays(event.days)}
                </span>
              </Field>
              <Field label="Source">{event.source || "System"}</Field>
              <Field label="Reference">{event.reference || "—"}</Field>
              <Field label="Created by">{event.created_by_name || "System"}</Field>
              <Field label="Created at">{formatDateTime(event.created_at)}</Field>
              <div className="col-span-2">
                <dt className="text-xs uppercase text-muted-foreground">Reason</dt>
                <dd className="mt-0.5">{event.reason || "—"}</dd>
              </div>
            </dl>

            <Separator />

            <div>
              <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">Balance impact (from ledger)</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Impact label="Before" value={impact?.before} />
                <Impact label="Transaction" value={impact?.txn} signed />
                <Impact label="After" value={impact?.after} />
              </div>
            </div>

            {source && (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Source record</p>
                {source.kind === "leave_request" ? (
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-mono">{source.request_id}</span> — {source.status}
                      <div className="text-xs text-muted-foreground">
                        {String(source.from_date).slice(0, 10)} → {String(source.to_date).slice(0, 10)} · {source.days} day(s)
                      </div>
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/modules/hr/leave-requests?ref=${source.request_id}`}>Open request</Link>
                    </Button>
                  </div>
                ) : source.kind === "adjustment" ? (
                  <div>
                    <span className="font-mono">{source.adjustment_id}</span> · {formatDays(source.days)} · {source.status}
                    <div className="text-xs text-muted-foreground">
                      By {source.actor_name || "—"} · {formatDateTime(source.created_at)}
                    </div>
                  </div>
                ) : (
                  <div>
                    Reverses <span className="font-mono">{source.reference}</span>
                  </div>
                )}
              </div>
            )}

            {reversedBy && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                This event was reversed by <span className="font-mono">{reversedBy.quota_event_id}</span> (
                {formatDays(reversedBy.days)}) on {formatDateTime(reversedBy.created_at)}.
              </div>
            )}

            {canReverse && (
              <div className="rounded-lg border p-3">
                {!showReverse ? (
                  <Button variant="outline" onClick={() => setShowReverse(true)}>
                    Reverse this event
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      This posts an opposite entry ({formatDays(-Number(event.days))}) referencing {event.quota_event_id}. The
                      original is preserved.
                    </p>
                    <Textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason for the reversal (optional)"
                      rows={2}
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setShowReverse(false)} disabled={reversing}>
                        Cancel
                      </Button>
                      <Button variant="destructive" onClick={reverse} disabled={reversing}>
                        {reversing ? "Reversing…" : "Confirm reversal"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

function Impact({ label, value, signed }: { label: string; value?: number; signed?: boolean }) {
  const num = Number(value || 0)
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${signed ? (num < 0 ? "text-destructive" : "text-emerald-600") : ""}`}>
        {signed ? formatDays(num) : num}
      </p>
    </div>
  )
}
