"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Plus, Trash2, Loader2Icon } from "lucide-react"
import { inr } from "@/lib/finance-calc"

type PostableAccount = {
  account_id: string
  account_code: string | null
  account_name: string
  account_group: string | null
  account_type: string | null
  nature: string | null
}

type LineDraft = {
  key: string
  accountId: string
  debit: string
  credit: string
  narration: string
}

const VOUCHER_TYPES = ["Journal", "Payment", "Receipt", "Contra"]

const num = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)
let seq = 0
const newLine = (): LineDraft => ({ key: `l${++seq}`, accountId: "", debit: "", credit: "", narration: "" })

export function ManualJournalDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (journalId: string) => void
}) {
  const { data } = useSWR<{ accounts: PostableAccount[] }>(
    open ? "/api/finance/journal-entries/manual" : null,
    fetcher,
  )
  const accounts = data?.accounts ?? []

  const [journalDate, setJournalDate] = useState(today())
  const [voucherType, setVoucherType] = useState("Journal")
  const [referenceNo, setReferenceNo] = useState("")
  const [narration, setNarration] = useState("")
  const [lines, setLines] = useState<LineDraft[]>([newLine(), newLine()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Accounts grouped for a tidy <optgroup> picker.
  const grouped = useMemo(() => {
    const map = new Map<string, PostableAccount[]>()
    for (const a of accounts) {
      const g = a.account_group || "Other"
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(a)
    }
    return Array.from(map.entries())
  }, [accounts])

  const totalDebit = round2(lines.reduce((s, l) => s + num(l.debit), 0))
  const totalCredit = round2(lines.reduce((s, l) => s + num(l.credit), 0))
  const difference = round2(totalDebit - totalCredit)
  const balanced = Math.abs(difference) < 0.01 && totalDebit > 0
  const enoughLines = lines.filter((l) => l.accountId && (num(l.debit) > 0 || num(l.credit) > 0)).length >= 2
  const canSave = balanced && enoughLines && !saving

  function reset() {
    setJournalDate(today())
    setVoucherType("Journal")
    setReferenceNo("")
    setNarration("")
    setLines([newLine(), newLine()])
    setError(null)
  }

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setLines((prev) => [...prev, newLine()])
  }
  function removeLine(key: string) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((l) => l.key !== key)))
  }

  async function save() {
    setError(null)
    setSaving(true)
    try {
      const payload = {
        journalDate,
        voucherType,
        referenceNo: referenceNo || null,
        narration: narration || null,
        lines: lines
          .filter((l) => l.accountId && (num(l.debit) > 0 || num(l.credit) > 0))
          .map((l) => ({
            accountId: l.accountId,
            debit: num(l.debit),
            credit: num(l.credit),
            narration: l.narration || null,
          })),
      }
      const res = await fetch("/api/finance/journal-entries/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || "Could not post the journal.")
        return
      }
      onSaved(json.journalId)
      reset()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>New manual journal</DialogTitle>
          <DialogDescription>
            Enter a balanced double-entry voucher. Total debit must equal total credit before it can post to the
            general ledger.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="mj-date">Journal date</FieldLabel>
              <Input id="mj-date" type="date" value={journalDate} onChange={(e) => setJournalDate(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="mj-type">Voucher type</FieldLabel>
              <select
                id="mj-type"
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={voucherType}
                onChange={(e) => setVoucherType(e.target.value)}
              >
                {VOUCHER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <FieldLabel htmlFor="mj-ref">Reference no. (optional)</FieldLabel>
              <Input
                id="mj-ref"
                value={referenceNo}
                onChange={(e) => setReferenceNo(e.target.value)}
                placeholder="e.g. adjustment memo, cheque no."
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-muted-foreground">
                  <th className="p-2 font-medium">Account</th>
                  <th className="p-2 font-medium">Line narration</th>
                  <th className="p-2 text-right font-medium">Debit</th>
                  <th className="p-2 text-right font-medium">Credit</th>
                  <th className="w-10 p-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key} className="border-b last:border-0">
                    <td className="p-2 align-top">
                      <select
                        aria-label="Account"
                        className="h-9 w-full min-w-[12rem] rounded-md border bg-background px-2 text-sm"
                        value={line.accountId}
                        onChange={(e) => updateLine(line.key, { accountId: e.target.value })}
                      >
                        <option value="">Select account…</option>
                        {grouped.map(([group, accs]) => (
                          <optgroup key={group} label={group}>
                            {accs.map((a) => (
                              <option key={a.account_id} value={a.account_id}>
                                {a.account_code ? `${a.account_code} — ` : ""}
                                {a.account_name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td className="p-2 align-top">
                      <Input
                        aria-label="Line narration"
                        value={line.narration}
                        onChange={(e) => updateLine(line.key, { narration: e.target.value })}
                        placeholder="Optional"
                        className="h-9"
                      />
                    </td>
                    <td className="p-2 align-top">
                      <Input
                        aria-label="Debit"
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={line.debit}
                        onChange={(e) => updateLine(line.key, { debit: e.target.value, credit: "" })}
                        className="h-9 text-right"
                      />
                    </td>
                    <td className="p-2 align-top">
                      <Input
                        aria-label="Credit"
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={line.credit}
                        onChange={(e) => updateLine(line.key, { credit: e.target.value, debit: "" })}
                        className="h-9 text-right"
                      />
                    </td>
                    <td className="p-2 text-right align-top">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove line"
                        disabled={lines.length <= 2}
                        onClick={() => removeLine(line.key)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30 font-medium">
                  <td className="p-2" colSpan={2}>
                    <Button variant="outline" size="sm" onClick={addLine}>
                      <Plus data-icon="inline-start" />
                      Add line
                    </Button>
                  </td>
                  <td className="p-2 text-right tabular-nums">{inr(totalDebit)}</td>
                  <td className="p-2 text-right tabular-nums">{inr(totalCredit)}</td>
                  <td className="p-2" />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1.5 flex-1 min-w-[16rem]">
              <FieldLabel htmlFor="mj-narration">Narration</FieldLabel>
              <Textarea
                id="mj-narration"
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                placeholder="Describe the purpose of this journal"
                rows={2}
              />
            </div>
            <div className="flex items-center gap-2">
              {balanced ? (
                <Badge variant="default">Balanced</Badge>
              ) : (
                <Badge variant="destructive">Out of balance: {inr(Math.abs(difference))}</Badge>
              )}
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {saving && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Post journal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
