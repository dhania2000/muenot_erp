"use client"

import { useMemo, useState } from "react"
import { Plus, Trash2, Upload, Loader2, TriangleAlert } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  EXPENSE_CATEGORIES,
  MILEAGE_RATE,
  categoryByKey,
  computeClaimTotals,
  computeLineAmount,
  validateClaim,
  type ClaimLine,
} from "@/lib/expense-claims-core"

type EmployeeOption = {
  employee_id: string | null
  employee_name: string | null
  department: string | null
  designation: string | null
  employee_email: string | null
  employee_manager: string | null
}

type ClaimFormValue = {
  id?: number
  title?: string
  employee_id?: string | null
  claim_date?: string
  period_from?: string | null
  period_to?: string | null
  notes?: string | null
  lines: ClaimLine[]
}

const money = (n: number) => `₹${(Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const inputClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

function emptyLine(): ClaimLine {
  return {
    category: "meals",
    description: "",
    date: new Date().toISOString().slice(0, 10),
    amount: 0,
    is_mileage: false,
    corporate_card: false,
    receipt_url: null,
  }
}

export function ClaimFormDialog({
  open,
  onOpenChange,
  initial,
  canApprove,
  employees,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: ClaimFormValue | null
  canApprove: boolean
  employees: EmployeeOption[]
  onSaved: () => void
}) {
  const [title, setTitle] = useState(initial?.title ?? "")
  const [employeeId, setEmployeeId] = useState(initial?.employee_id ?? "")
  const [claimDate, setClaimDate] = useState(initial?.claim_date ?? new Date().toISOString().slice(0, 10))
  const [periodFrom, setPeriodFrom] = useState(initial?.period_from ?? "")
  const [periodTo, setPeriodTo] = useState(initial?.period_to ?? "")
  const [notes, setNotes] = useState(initial?.notes ?? "")
  const [lines, setLines] = useState<ClaimLine[]>(initial?.lines?.length ? initial.lines : [emptyLine()])
  const [saving, setSaving] = useState(false)
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const totals = useMemo(() => computeClaimTotals(lines), [lines])
  const violations = useMemo(() => validateClaim(lines, { today: new Date().toISOString().slice(0, 10) }), [lines])

  function patchLine(idx: number, patch: Partial<ClaimLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  }

  function setCategory(idx: number, key: string) {
    const cat = categoryByKey(key)
    patchLine(idx, {
      category: key,
      is_mileage: !!cat?.mileage,
      mileage_rate: cat?.mileage ? MILEAGE_RATE : undefined,
    })
  }

  async function uploadReceipt(idx: number, file: File) {
    setUploadingIdx(idx)
    setError(null)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/finance/expenses/documents/upload", { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Upload failed")
      patchLine(idx, { receipt_url: data.url || data.path || data.location || null })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploadingIdx(null)
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const payload: Record<string, any> = {
        title,
        claim_date: claimDate,
        period_from: periodFrom || null,
        period_to: periodTo || null,
        notes,
        lines,
      }
      if (canApprove && employeeId) {
        const emp = employees.find((e) => e.employee_id === employeeId)
        payload.employee = emp || { employee_id: employeeId }
      }
      const editing = initial?.id != null
      if (editing) payload.id = initial!.id
      const res = await fetch("/api/hr/expense-claims", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Save failed")
      onSaved()
      onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial?.id ? "Edit expense claim" : "New expense claim"}</DialogTitle>
          <DialogDescription>
            Add each expense as a line. Mileage is reimbursed at ₹{MILEAGE_RATE}/km. Receipts are required for
            out-of-pocket lines of ₹500 or more.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="claim-title">Purpose / title</Label>
              <Input
                id="claim-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Client visit — Mumbai"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="claim-date">Claim date</Label>
              <Input id="claim-date" type="date" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} />
            </div>
            {canApprove && (
              <div className="grid gap-1.5">
                <Label htmlFor="claim-emp">Employee</Label>
                <select
                  id="claim-emp"
                  className={inputClass}
                  value={employeeId ?? ""}
                  onChange={(e) => setEmployeeId(e.target.value)}
                >
                  <option value="">Myself</option>
                  {employees.map((e) => (
                    <option key={e.employee_id ?? ""} value={e.employee_id ?? ""}>
                      {e.employee_name} {e.employee_id ? `(${e.employee_id})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="claim-from">Trip from</Label>
                <Input id="claim-from" type="date" value={periodFrom ?? ""} onChange={(e) => setPeriodFrom(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="claim-to">Trip to</Label>
                <Input id="claim-to" type="date" value={periodTo ?? ""} onChange={(e) => setPeriodTo(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <h3 className="text-sm font-medium">Expense lines</h3>
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((p) => [...p, emptyLine()])}>
                <Plus className="mr-1 size-4" /> Add line
              </Button>
            </div>
            <div className="divide-y">
              {lines.map((line, idx) => {
                const cat = categoryByKey(line.category)
                const amount = computeLineAmount(line)
                return (
                  <div key={idx} className="grid gap-2 p-3 sm:grid-cols-12 sm:items-end">
                    <div className="grid gap-1 sm:col-span-3">
                      <Label className="text-xs text-muted-foreground">Category</Label>
                      <select className={inputClass} value={line.category} onChange={(e) => setCategory(idx, e.target.value)}>
                        {EXPENSE_CATEGORIES.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="grid gap-1 sm:col-span-3">
                      <Label className="text-xs text-muted-foreground">Description</Label>
                      <Input value={line.description} onChange={(e) => patchLine(idx, { description: e.target.value })} />
                    </div>
                    <div className="grid gap-1 sm:col-span-2">
                      <Label className="text-xs text-muted-foreground">Date</Label>
                      <Input type="date" value={line.date} onChange={(e) => patchLine(idx, { date: e.target.value })} />
                    </div>

                    {line.is_mileage ? (
                      <div className="grid gap-1 sm:col-span-2">
                        <Label className="text-xs text-muted-foreground">Distance (km)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={line.distance_km ?? ""}
                          onChange={(e) => patchLine(idx, { distance_km: Number(e.target.value) })}
                        />
                      </div>
                    ) : (
                      <div className="grid gap-1 sm:col-span-2">
                        <Label className="text-xs text-muted-foreground">Amount (₹)</Label>
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={line.amount ?? ""}
                          onChange={(e) => patchLine(idx, { amount: Number(e.target.value) })}
                        />
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2 sm:col-span-2">
                      <div className="text-sm font-medium tabular-nums">{money(amount)}</div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, i) => i !== idx) : p))}
                        aria-label={`Remove line ${idx + 1}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 sm:col-span-12">
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={!!line.corporate_card}
                          onChange={(e) => patchLine(idx, { corporate_card: e.target.checked })}
                        />
                        Paid on corporate card
                      </label>
                      {line.corporate_card && (
                        <Input
                          className="h-7 w-24 text-xs"
                          placeholder="Card ••1234"
                          value={line.card_last4 ?? ""}
                          onChange={(e) => patchLine(idx, { card_last4: e.target.value })}
                        />
                      )}
                      {!line.is_mileage && (
                        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                          {uploadingIdx === idx ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Upload className="size-3.5" />
                          )}
                          {line.receipt_url ? "Replace receipt" : "Attach receipt"}
                          <input
                            type="file"
                            className="hidden"
                            accept="image/*,application/pdf"
                            onChange={(e) => {
                              const f = e.target.files?.[0]
                              if (f) uploadReceipt(idx, f)
                            }}
                          />
                        </label>
                      )}
                      {line.receipt_url && (
                        <a
                          href={line.receipt_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-primary underline underline-offset-2"
                        >
                          View receipt
                        </a>
                      )}
                      {cat && cat.cap > 0 && (
                        <span className="ml-auto text-xs text-muted-foreground">Policy cap {money(cat.cap)}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {violations.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300">
                <TriangleAlert className="size-4" /> Policy checks
              </div>
              <ul className="space-y-0.5">
                {violations.map((v, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Badge variant={v.severity === "error" ? "destructive" : "secondary"} className="shrink-0">
                      {v.severity}
                    </Badge>
                    <span>{v.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="claim-notes">Notes for approver</Label>
            <Textarea id="claim-notes" rows={2} value={notes ?? ""} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 rounded-lg bg-muted/50 px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              Mileage <span className="font-medium text-foreground">{money(totals.mileage)}</span>
            </span>
            <span className="text-muted-foreground">
              On corporate card <span className="font-medium text-foreground">{money(totals.corporateCard)}</span>
            </span>
            <span className="text-muted-foreground">
              Reimbursable <span className="font-medium text-foreground">{money(totals.reimbursable)}</span>
            </span>
            <span className="text-base font-semibold">Total {money(totals.gross)}</span>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
            {initial?.id ? "Save changes" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
