"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  ReceiptText,
  Plus,
  Loader2,
  Check,
  X,
  Send,
  Banknote,
  RotateCcw,
  Ban,
  Pencil,
  Trash2,
  CreditCard,
  Car,
} from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  STATUS_TONE,
  computeLineAmount,
  categoryByKey,
  type ClaimStatus,
  type ClaimLine,
  type PolicyViolation,
} from "@/lib/expense-claims-core"
import { ClaimFormDialog } from "./claim-form-dialog"

type Claim = {
  id: number
  claim_id: string
  title: string | null
  employee_name: string | null
  employee_id: string | null
  department: string | null
  claim_date: string | null
  status: ClaimStatus
  lines: ClaimLine[]
  policy_violations: PolicyViolation[]
  gross_total: number
  reimbursable_total: number
  corporate_card_total: number
  mileage_total: number
  notes: string | null
  rejected_reason: string | null
  approved_by_name: string | null
  voucher_no: string | null
  finance_expense_id: string | null
  reimbursement_reference: string | null
  created_by: number
}

type ApiResponse = {
  claims: Claim[]
  me: { employee_id: string | null; employee_name: string | null } | null
  employees: any[]
  canApprove: boolean
}

const money = (n: number) => `₹${(Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const FILTERS: (ClaimStatus | "All")[] = ["All", "Draft", "Submitted", "Approved", "Reimbursed", "Rejected"]

export function ExpenseClaimsClient() {
  const { data, isLoading, mutate } = useSWR<ApiResponse>("/api/hr/expense-claims", fetcher)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Claim | null>(null)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All")
  const [q, setQ] = useState("")
  const [busyId, setBusyId] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const claims = data?.claims ?? []
  const canApprove = !!data?.canApprove

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return claims.filter((c) => {
      if (filter !== "All" && c.status !== filter) return false
      if (!needle) return true
      return [c.claim_id, c.title, c.employee_name, c.employee_id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    })
  }, [claims, filter, q])

  const stats = useMemo(() => {
    const s = { pending: 0, approved: 0, reimbursable: 0, reimbursed: 0 }
    for (const c of claims) {
      if (c.status === "Submitted") s.pending += 1
      if (c.status === "Approved") {
        s.approved += 1
        s.reimbursable += Number(c.reimbursable_total) || 0
      }
      if (c.status === "Reimbursed") s.reimbursed += Number(c.reimbursable_total) || 0
    }
    return s
  }, [claims])

  async function act(claim: Claim, action: string, extra: Record<string, any> = {}) {
    setBusyId(claim.id)
    setError(null)
    try {
      const res = await fetch("/api/hr/expense-claims/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: claim.id, action, ...extra }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || "Action failed")
      await mutate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function remove(claim: Claim) {
    if (!confirm(`Delete claim ${claim.claim_id}? This cannot be undone.`)) return
    setBusyId(claim.id)
    setError(null)
    try {
      const res = await fetch(`/api/hr/expense-claims?id=${claim.id}`, { method: "DELETE" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || "Delete failed")
      await mutate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  function openNew() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(claim: Claim) {
    setEditing(claim)
    setFormOpen(true)
  }

  const isOwner = (c: Claim) => data?.me == null || c.created_by === undefined || true // ownership already enforced server-side

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ReceiptText className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Expense Claims & Reimbursements</h1>
            <p className="text-sm text-muted-foreground">
              Submit expenses with receipts, mileage and corporate-card spend for approval and Finance posting.
            </p>
          </div>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-1 size-4" /> New claim
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Awaiting approval" value={String(stats.pending)} />
        <StatCard label="Approved" value={String(stats.approved)} />
        <StatCard label="Reimbursable" value={money(stats.reimbursable)} />
        <StatCard label="Reimbursed" value={money(stats.reimbursed)} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              onClick={() => setFilter(f)}
            >
              {f}
            </Button>
          ))}
        </div>
        <Input
          placeholder="Search claim, title or employee…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="sm:max-w-xs"
        />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading claims…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <ReceiptText className="size-8 text-muted-foreground/60" />
              <p className="text-sm font-medium">No claims found</p>
              <p className="text-sm text-muted-foreground">Create your first expense claim to get started.</p>
            </div>
          ) : (
            <div className="divide-y">
              {filtered.map((c) => {
                const open = expanded === c.id
                const canEdit = c.status === "Draft" || c.status === "Rejected"
                return (
                  <div key={c.id}>
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : c.id)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{c.title || "Untitled claim"}</span>
                          <span className="font-mono text-xs text-muted-foreground">{c.claim_id}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          <span>{c.employee_name || "—"}</span>
                          {c.claim_date && <span>{c.claim_date}</span>}
                          {Number(c.mileage_total) > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <Car className="size-3" /> {money(c.mileage_total)}
                            </span>
                          )}
                          {Number(c.corporate_card_total) > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <CreditCard className="size-3" /> {money(c.corporate_card_total)}
                            </span>
                          )}
                          {c.voucher_no && <span className="text-emerald-600 dark:text-emerald-400">Voucher {c.voucher_no}</span>}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold tabular-nums">{money(c.gross_total)}</div>
                        <div className="text-xs text-muted-foreground">{money(c.reimbursable_total)} reimbursable</div>
                      </div>
                      <Badge className={`shrink-0 ${STATUS_TONE[c.status] ?? ""}`} variant="secondary">
                        {c.status}
                      </Badge>
                    </button>

                    {open && (
                      <div className="border-t bg-muted/20 px-4 py-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-xs uppercase text-muted-foreground">
                                <th className="py-1 pr-3 font-medium">Category</th>
                                <th className="py-1 pr-3 font-medium">Description</th>
                                <th className="py-1 pr-3 font-medium">Date</th>
                                <th className="py-1 pr-3 font-medium">Flags</th>
                                <th className="py-1 pr-3 text-right font-medium">Amount</th>
                                <th className="py-1 font-medium">Receipt</th>
                              </tr>
                            </thead>
                            <tbody>
                              {c.lines.map((l, i) => (
                                <tr key={i} className="border-t border-border/50">
                                  <td className="py-1.5 pr-3">{categoryByKey(l.category)?.label ?? l.category}</td>
                                  <td className="py-1.5 pr-3 text-muted-foreground">{l.description || "—"}</td>
                                  <td className="py-1.5 pr-3 tabular-nums">{l.date}</td>
                                  <td className="py-1.5 pr-3">
                                    <span className="flex flex-wrap gap-1">
                                      {l.is_mileage && (
                                        <Badge variant="outline" className="gap-1 text-[10px]">
                                          <Car className="size-3" /> {l.distance_km ?? 0} km
                                        </Badge>
                                      )}
                                      {l.corporate_card && (
                                        <Badge variant="outline" className="gap-1 text-[10px]">
                                          <CreditCard className="size-3" /> Card
                                        </Badge>
                                      )}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3 text-right tabular-nums">{money(computeLineAmount(l))}</td>
                                  <td className="py-1.5">
                                    {l.receipt_url ? (
                                      <a
                                        href={l.receipt_url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-primary underline underline-offset-2"
                                      >
                                        View
                                      </a>
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {c.policy_violations.length > 0 && (
                          <ul className="mt-3 space-y-1 text-xs">
                            {c.policy_violations.map((v, i) => (
                              <li key={i} className="flex items-center gap-2">
                                <Badge variant={v.severity === "error" ? "destructive" : "secondary"} className="text-[10px]">
                                  {v.severity}
                                </Badge>
                                <span className="text-muted-foreground">{v.message}</span>
                              </li>
                            ))}
                          </ul>
                        )}

                        {c.rejected_reason && c.status === "Rejected" && (
                          <p className="mt-3 text-xs text-destructive">Rejected: {c.rejected_reason}</p>
                        )}
                        {c.approved_by_name && (c.status === "Approved" || c.status === "Reimbursed") && (
                          <p className="mt-3 text-xs text-muted-foreground">
                            Approved by {c.approved_by_name}
                            {c.voucher_no ? ` · posted to Finance as voucher ${c.voucher_no}` : ""}
                            {c.reimbursement_reference ? ` · reimbursed ref ${c.reimbursement_reference}` : ""}
                          </p>
                        )}

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          {(c.status === "Draft" || c.status === "Rejected") && (
                            <Button size="sm" onClick={() => act(c, "submit")} disabled={busyId === c.id}>
                              {busyId === c.id ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Send className="mr-1 size-4" />}
                              Submit
                            </Button>
                          )}
                          {canEdit && (
                            <Button size="sm" variant="outline" onClick={() => openEdit(c)} disabled={busyId === c.id}>
                              <Pencil className="mr-1 size-4" /> Edit
                            </Button>
                          )}
                          {canApprove && c.status === "Submitted" && (
                            <>
                              <Button size="sm" onClick={() => act(c, "approve")} disabled={busyId === c.id}>
                                <Check className="mr-1 size-4" /> Approve & post
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const reason = prompt("Reason for rejection?")
                                  if (reason != null) act(c, "reject", { reason })
                                }}
                                disabled={busyId === c.id}
                              >
                                <X className="mr-1 size-4" /> Reject
                              </Button>
                            </>
                          )}
                          {canApprove && c.status === "Approved" && (
                            <Button
                              size="sm"
                              onClick={() => {
                                const reference = prompt("Payment reference (UTR / cheque no.)?") || ""
                                act(c, "reimburse", { reference })
                              }}
                              disabled={busyId === c.id}
                            >
                              <Banknote className="mr-1 size-4" /> Mark reimbursed
                            </Button>
                          )}
                          {(c.status === "Draft" || c.status === "Submitted") && (
                            <Button size="sm" variant="ghost" onClick={() => act(c, "cancel")} disabled={busyId === c.id}>
                              <Ban className="mr-1 size-4" /> Cancel
                            </Button>
                          )}
                          {(c.status === "Rejected" || c.status === "Cancelled") && (
                            <Button size="sm" variant="ghost" onClick={() => act(c, "reopen")} disabled={busyId === c.id}>
                              <RotateCcw className="mr-1 size-4" /> Reopen
                            </Button>
                          )}
                          {canEdit && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => remove(c)}
                              disabled={busyId === c.id}
                            >
                              <Trash2 className="mr-1 size-4" /> Delete
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {formOpen && (
        <ClaimFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          canApprove={canApprove}
          employees={data?.employees ?? []}
          initial={
            editing
              ? {
                  id: editing.id,
                  title: editing.title ?? "",
                  employee_id: editing.employee_id,
                  claim_date: editing.claim_date ?? undefined,
                  notes: editing.notes,
                  lines: editing.lines,
                }
              : null
          }
          onSaved={() => mutate()}
        />
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  )
}
