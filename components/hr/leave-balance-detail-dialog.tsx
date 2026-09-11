"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"

export type BalanceKey = { employee_id: number; leave_type_id: number; year: number } | null

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Healthy: "default",
  "Low Balance": "secondary",
  "Zero Balance": "outline",
  Negative: "destructive",
}

const EVENT_LABEL: Record<string, string> = {
  opening: "Opening",
  accrual: "Accrual",
  carry_forward: "Carry forward",
  adjustment: "Adjustment",
  leave_approved: "Leave used",
  leave_reversed: "Leave reversal",
  expiry: "Expiry / lapse",
}

function n(v: any) {
  return Number(v || 0)
}

export function LeaveBalanceDetailDialog({
  balanceKey,
  onClose,
  canManage,
  onAdjust,
  onChanged,
}: {
  balanceKey: BalanceKey
  onClose: () => void
  canManage: boolean
  onAdjust: (preset: { employee_id: string; leave_type_id: string; year: number }) => void
  onChanged: () => void
}) {
  const url = balanceKey
    ? `/api/hr/leave-balances/detail?employee_id=${balanceKey.employee_id}&leave_type_id=${balanceKey.leave_type_id}&year=${balanceKey.year}`
    : null
  const { data, isLoading, mutate } = useSWR<any>(url, fetcher)
  const [reconciling, setReconciling] = useState(false)

  const b = data?.balance
  const recon = data?.reconciliation

  async function reconcile() {
    if (!balanceKey) return
    setReconciling(true)
    try {
      const res = await fetch("/api/hr/leave-balances/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(balanceKey),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error || "Reconciliation failed.")
        return
      }
      if (json.reconciliation.ok) toast.success("Balance reconciles with the ledger.")
      else toast.warning(`Discrepancy of ${json.reconciliation.discrepancy} day(s) detected.`)
      mutate()
    } finally {
      setReconciling(false)
    }
  }

  const breakdown: { label: string; value: number; sign: "+" | "-" | "" }[] = b
    ? [
        { label: "Opening", value: n(b.opening), sign: "+" },
        { label: "Accrued", value: n(b.accrued), sign: "+" },
        { label: "Carry forward", value: n(b.carry_forward), sign: "+" },
        { label: "Adjusted", value: n(b.adjusted), sign: b.adjusted < 0 ? "-" : "+" },
        { label: "Used", value: n(b.used), sign: "-" },
        { label: "Pending", value: n(b.pending), sign: "-" },
        { label: "Expired / lapsed", value: n(b.expired), sign: "-" },
      ]
    : []

  return (
    <Dialog open={Boolean(balanceKey)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {data ? `${data.leaveType.leave_type} — ${data.year}` : "Leave balance"}
            {data?.status && <Badge variant={STATUS_VARIANT[data.status] || "outline"}>{data.status}</Badge>}
          </DialogTitle>
          <DialogDescription>
            {data
              ? `${data.employee.employee_name} · ${data.employee.employee_id}${data.employee.department ? ` · ${data.employee.department}` : ""}`
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5">
            {/* Balance summary + formula */}
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">Available</p>
                  <p className="text-3xl font-semibold">{n(b.available)}</p>
                </div>
                {canManage && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onAdjust({
                        employee_id: String(data.employee.id),
                        leave_type_id: data.leaveType.leave_type_id,
                        year: data.year,
                      })
                    }
                  >
                    Adjust
                  </Button>
                )}
              </div>
              <Separator className="my-3" />
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                {breakdown.map((row) => (
                  <div key={row.label}>
                    <p className="text-xs text-muted-foreground">{row.label}</p>
                    <p className={row.sign === "-" ? "text-destructive" : ""}>
                      {row.sign}
                      {row.value}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Available = Opening + Accrued + Carry forward + Adjusted − Used − Pending − Expired
              </p>
            </div>

            {/* Reconciliation */}
            {recon && (
              <div
                className={`rounded-lg border p-3 text-sm ${
                  recon.ok ? "bg-muted/30" : "border-destructive/40 bg-destructive/10"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium uppercase text-muted-foreground">Reconciliation</p>
                    <p className="mt-1">
                      {recon.ok
                        ? "Stored balance matches the quota-history ledger."
                        : `Discrepancy of ${recon.discrepancy} day(s) between stored balance and ledger.`}
                    </p>
                  </div>
                  {canManage && (
                    <Button size="sm" variant="outline" onClick={reconcile} disabled={reconciling}>
                      {reconciling ? "Checking…" : "Re-check"}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Transaction history */}
            <Section title="Transaction history">
              {data.history.length === 0 ? (
                <Empty>No ledger entries yet.</Empty>
              ) : (
                <ol className="space-y-2">
                  {data.history.map((h: any) => (
                    <li key={h.event_id} className="flex items-start justify-between gap-3 text-sm">
                      <div>
                        <span className="font-medium">{EVENT_LABEL[h.event_type] || h.event_type}</span>
                        {h.reference && <span className="ml-2 font-mono text-xs text-muted-foreground">{h.reference}</span>}
                        <p className="text-xs text-muted-foreground">
                          {String(h.created_at).slice(0, 16).replace("T", " ")}
                          {h.created_by_name ? ` · ${h.created_by_name}` : " · System"}
                          {h.reason ? ` · ${h.reason}` : ""}
                        </p>
                      </div>
                      <span className={`shrink-0 font-medium ${n(h.days) < 0 ? "text-destructive" : "text-emerald-600"}`}>
                        {n(h.days) > 0 ? "+" : ""}
                        {n(h.days)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            {/* Related leave requests */}
            <Section title="Related leave requests">
              {data.requests.length === 0 ? (
                <Empty>No leave requests for this type and year.</Empty>
              ) : (
                <ul className="space-y-2">
                  {data.requests.map((r: any) => (
                    <li key={r.request_id} className="flex items-center justify-between gap-3 text-sm">
                      <div>
                        <span className="font-mono text-xs">{r.request_id}</span>
                        <p className="text-xs text-muted-foreground">
                          {String(r.from_date).slice(0, 10)}
                          {r.from_date !== r.to_date && ` → ${String(r.to_date).slice(0, 10)}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{r.days} day(s)</span>
                        <Badge variant="outline">{r.status}</Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* Adjustment records */}
            {data.adjustments.length > 0 && (
              <Section title="Adjustments">
                <ul className="space-y-2">
                  {data.adjustments.map((a: any) => (
                    <li key={a.adjustment_id} className="flex items-start justify-between gap-3 text-sm">
                      <div>
                        <span className="font-mono text-xs">{a.adjustment_id}</span>
                        <p className="text-xs text-muted-foreground">
                          {String(a.created_at).slice(0, 16).replace("T", " ")}
                          {a.actor_name ? ` · ${a.actor_name}` : ""} · {a.reason}
                        </p>
                      </div>
                      <span className={`shrink-0 font-medium ${n(a.days) < 0 ? "text-destructive" : "text-emerald-600"}`}>
                        {n(a.days) > 0 ? "+" : ""}
                        {n(a.days)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Audit trail */}
            {data.audit.length > 0 && (
              <Section title="Audit history">
                <ol className="space-y-2">
                  {data.audit.map((e: any, i: number) => (
                    <li key={i} className="text-sm">
                      <p>{e.summary}</p>
                      <p className="text-xs text-muted-foreground">
                        {String(e.created_at).slice(0, 16).replace("T", " ")}
                        {e.actor_name ? ` · ${e.actor_name}` : ""}
                      </p>
                    </li>
                  ))}
                </ol>
              </Section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}
