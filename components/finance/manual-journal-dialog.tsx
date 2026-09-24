"use client"

import { useEffect, useMemo, useState } from "react"
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

type PartyOption = { id: string; name: string; source: string }
type ProjectOption = { id: string; name: string }

type LineDraft = {
  key: string
  accountId: string
  debit: string
  credit: string
  narration: string
  partyId: string
  projectId: string
  costCentre: string
  gst: string
  tds: string
}

/**
 * SPEC 165 — context for raising a linked adjustment / correction /
 * reclassification against a POSTED journal. The dialog is seeded from the
 * original and posts to the /adjust endpoint instead of editing anything.
 */
export type AdjustmentContext = {
  originalId: string
  kind: "Adjustment" | "Correction" | "Reclassification"
  seed: {
    journalDate?: string
    voucherType?: string
    referenceNo?: string
    narration?: string
    lines: EditableJournal["lines"]
  }
}

/** An existing unposted journal loaded for editing. */
export type EditableJournal = {
  journalId: string
  journalDate: string
  voucherType: string
  referenceNo: string
  narration: string
  paymentMode?: string
  chequeUtrReference?: string
  attachmentUrl?: string
  attachmentType?: string
  lines: Array<{
    accountId: string
    debit: number
    credit: number
    narration: string
    partyId?: string
    projectId?: string
    costCentre?: string
    gst?: number
    tds?: number
  }>
}

const VOUCHER_TYPES = [
  "Journal", "Payment", "Receipt", "Contra", "Sales", "Purchase", "Expense",
  "Credit Note", "Debit Note", "GST", "TDS", "Adjustment", "Opening", "Closing",
]

const PAYMENT_MODES = ["Bank", "Cash", "Cheque", "UPI", "Card", "Transfer", "Other"]
const ATTACHMENT_TYPES = ["Invoice", "Bill", "Receipt", "Payment Proof", "Other"]

const num = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)
let seq = 0
const newLine = (): LineDraft => ({
  key: `l${++seq}`,
  accountId: "",
  debit: "",
  credit: "",
  narration: "",
  partyId: "",
  projectId: "",
  costCentre: "",
  gst: "",
  tds: "",
})

export function ManualJournalDialog({
  open,
  onOpenChange,
  onSaved,
  editJournal = null,
  adjustment = null,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (journalId: string) => void
  editJournal?: EditableJournal | null
  adjustment?: AdjustmentContext | null
}) {
  const isEdit = !!editJournal
  const isAdjust = !isEdit && !!adjustment
  const adjKind = adjustment?.kind ?? null
  const { data } = useSWR<{ accounts: PostableAccount[] }>(
    open ? "/api/finance/journal-entries/manual" : null,
    fetcher,
  )
  const accounts = data?.accounts ?? []

  // Party / project / cost-centre pickers reuse the owning modules' masters.
  const { data: lookups } = useSWR<{ parties: PartyOption[]; projects: ProjectOption[]; costCentres: string[] }>(
    open ? "/api/finance/journal-entries/lookups" : null,
    fetcher,
  )
  const parties = lookups?.parties ?? []
  const projects = lookups?.projects ?? []
  const costCentres = lookups?.costCentres ?? []

  const [journalDate, setJournalDate] = useState(today())
  const [voucherType, setVoucherType] = useState("Journal")
  const [referenceNo, setReferenceNo] = useState("")
  const [narration, setNarration] = useState("")
  // Phase 36/37 — journal-level payment + supporting document.
  const [paymentMode, setPaymentMode] = useState("")
  const [chequeUtr, setChequeUtr] = useState("")
  const [attachmentUrl, setAttachmentUrl] = useState("")
  const [attachmentType, setAttachmentType] = useState("")
  const [lines, setLines] = useState<LineDraft[]>([newLine(), newLine()])
  const [saving, setSaving] = useState<"draft" | "submit" | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Hydrate the form from the journal being edited whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    if (editJournal) {
      setJournalDate(editJournal.journalDate?.slice(0, 10) || today())
      setVoucherType(editJournal.voucherType || "Journal")
      setReferenceNo(editJournal.referenceNo || "")
      setNarration(editJournal.narration || "")
      setPaymentMode(editJournal.paymentMode || "")
      setChequeUtr(editJournal.chequeUtrReference || "")
      setAttachmentUrl(editJournal.attachmentUrl || "")
      setAttachmentType(editJournal.attachmentType || "")
      setLines(
        editJournal.lines.length
          ? editJournal.lines.map((l) => ({
              key: `l${++seq}`,
              accountId: l.accountId,
              debit: l.debit ? String(l.debit) : "",
              credit: l.credit ? String(l.credit) : "",
              narration: l.narration || "",
              partyId: l.partyId || "",
              projectId: l.projectId || "",
              costCentre: l.costCentre || "",
              gst: l.gst ? String(l.gst) : "",
              tds: l.tds ? String(l.tds) : "",
            }))
          : [newLine(), newLine()],
      )
    } else if (adjustment) {
      // SPEC 165 — seed a linked adjustment from the posted original. A
      // Correction pre-fills the original's own lines (the operator edits the
      // corrected values); Adjustment/Reclassification start from blank lines
      // so the operator enters only the delta / reclassifying entry.
      const s = adjustment.seed
      setJournalDate(s.journalDate?.slice(0, 10) || today())
      setVoucherType(s.voucherType || (adjustment.kind === "Reclassification" ? "Journal" : "Adjustment"))
      setReferenceNo(s.referenceNo || adjustment.originalId)
      setNarration(s.narration || `${adjustment.kind} of ${adjustment.originalId}`)
      setPaymentMode("")
      setChequeUtr("")
      setAttachmentUrl("")
      setAttachmentType("")
      setLines(
        adjustment.kind === "Correction" && s.lines.length
          ? s.lines.map((l) => ({
              key: `l${++seq}`,
              accountId: l.accountId,
              debit: l.debit ? String(l.debit) : "",
              credit: l.credit ? String(l.credit) : "",
              narration: l.narration || "",
              partyId: l.partyId || "",
              projectId: l.projectId || "",
              costCentre: l.costCentre || "",
              gst: l.gst ? String(l.gst) : "",
              tds: l.tds ? String(l.tds) : "",
            }))
          : [newLine(), newLine()],
      )
    } else {
      setJournalDate(today())
      setVoucherType("Journal")
      setReferenceNo("")
      setNarration("")
      setLines([newLine(), newLine()])
    }
    setError(null)
  }, [open, editJournal, adjustment])

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

  // Parties grouped by their owning master so the picker shows the source.
  const partyGroups = useMemo(() => {
    const map = new Map<string, PartyOption[]>()
    for (const p of parties) {
      if (!map.has(p.source)) map.set(p.source, [])
      map.get(p.source)!.push(p)
    }
    return Array.from(map.entries())
  }, [parties])

  const totalDebit = round2(lines.reduce((s, l) => s + num(l.debit), 0))
  const totalCredit = round2(lines.reduce((s, l) => s + num(l.credit), 0))
  const difference = round2(totalDebit - totalCredit)
  const totalGst = round2(lines.reduce((s, l) => s + num(l.gst), 0))
  const totalTds = round2(lines.reduce((s, l) => s + num(l.tds), 0))
  const balanced = Math.abs(difference) < 0.01 && totalDebit > 0
  const enoughLines = lines.filter((l) => l.accountId && (num(l.debit) > 0 || num(l.credit) > 0)).length >= 2
  const canSave = balanced && enoughLines && !saving

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setLines((prev) => [...prev, newLine()])
  }
  function removeLine(key: string) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((l) => l.key !== key)))
  }

  async function save(mode: "draft" | "submit") {
    setError(null)
    setSaving(mode)
    try {
      const linePayload = lines
        .filter((l) => l.accountId && (num(l.debit) > 0 || num(l.credit) > 0))
        .map((l) => ({
          accountId: l.accountId,
          debit: num(l.debit),
          credit: num(l.credit),
          narration: l.narration || null,
          partyId: l.partyId || null,
          projectId: l.projectId || null,
          costCentre: l.costCentre || null,
          gst: num(l.gst),
          tds: num(l.tds),
        }))
      const base = {
        journalDate,
        voucherType,
        referenceNo: referenceNo || null,
        narration: narration || null,
        paymentMode: paymentMode || null,
        chequeUtrReference: chequeUtr || null,
        attachmentUrl: attachmentUrl || null,
        attachmentType: attachmentType || null,
        lines: linePayload,
      }

      // SPEC 165 — an adjustment posts to the dedicated /adjust endpoint, which
      // creates a NEW linked voucher against the posted original and never
      // rewrites its history. Editing an unposted journal replaces its lines
      // (PUT) and always returns it to Draft server-side; creating uses POST.
      const res = isAdjust
        ? await fetch("/api/finance/journal-entries/adjust", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              originalId: adjustment!.originalId,
              kind: adjustment!.kind,
              submit: mode === "submit",
              ...base,
            }),
          })
        : await fetch("/api/finance/journal-entries/manual", {
            method: isEdit ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              isEdit ? { journalId: editJournal!.journalId, ...base } : { ...base, submit: mode === "submit" },
            ),
          })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error || "Could not save the journal.")
        return
      }
      onSaved(json.journalId)
      onOpenChange(false)
    } finally {
      setSaving(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {isAdjust
              ? `${adjKind} of ${adjustment!.originalId}`
              : isEdit
                ? `Edit journal ${editJournal!.journalId}`
                : "New manual journal"}
          </DialogTitle>
          <DialogDescription>
            Enter a balanced double-entry voucher. Total debit must equal total credit.{" "}
            {isAdjust
              ? adjKind === "Correction"
                ? `This creates a new linked voucher and reverses ${adjustment!.originalId}; the original posting is never overwritten. It reaches the ledger only after approval and posting.`
                : `This creates a new linked ${adjKind!.toLowerCase()} voucher against ${adjustment!.originalId}; the original posting is never overwritten. It reaches the ledger only after approval and posting.`
              : isEdit
                ? "Saving returns the journal to Draft; it posts to the ledger only after it is approved and posted."
                : "The journal is saved unposted and only reaches the general ledger once it is approved and posted."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
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
                placeholder="Link a source doc (e.g. bill/expense id) to cross-check GST/TDS"
              />
            </div>

            {/* Phase 36 — how this voucher was settled. */}
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="mj-pay-mode">Payment mode (optional)</FieldLabel>
              <select
                id="mj-pay-mode"
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value)}
              >
                <option value="">Not specified</option>
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="mj-cheque">Cheque / UTR / reference</FieldLabel>
              <Input
                id="mj-cheque"
                value={chequeUtr}
                onChange={(e) => setChequeUtr(e.target.value)}
                placeholder="e.g. UTR / cheque no."
              />
            </div>

            {/* Phase 37 — a single supporting document for the voucher. */}
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="mj-att-type">Attachment type (optional)</FieldLabel>
              <select
                id="mj-att-type"
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={attachmentType}
                onChange={(e) => setAttachmentType(e.target.value)}
              >
                <option value="">Not specified</option>
                {ATTACHMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="mj-att-url">Attachment link</FieldLabel>
              <Input
                id="mj-att-url"
                value={attachmentUrl}
                onChange={(e) => setAttachmentUrl(e.target.value)}
                placeholder="Supporting document URL"
              />
            </div>
          </div>

          {/* One card per line: account + amounts on top, the party / project /
              cost-centre / GST / TDS dimensions below. */}
          <div className="space-y-3">
            {lines.map((line, idx) => (
              <div key={line.key} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Line {idx + 1}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove line"
                    disabled={lines.length <= 2}
                    onClick={() => removeLine(line.key)}
                    className="size-7"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="flex flex-col gap-1.5 lg:col-span-2">
                    <FieldLabel>Account</FieldLabel>
                    <select
                      aria-label="Account"
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
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
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>Debit</FieldLabel>
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
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>Credit</FieldLabel>
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
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>Party (optional)</FieldLabel>
                    <select
                      aria-label="Party"
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={line.partyId}
                      onChange={(e) => updateLine(line.key, { partyId: e.target.value })}
                    >
                      <option value="">No party</option>
                      {partyGroups.map(([source, list]) => (
                        <optgroup key={source} label={source}>
                          {list.map((p) => (
                            <option key={`${source}:${p.id}`} value={p.id}>
                              {p.name} ({p.id})
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>Project (optional)</FieldLabel>
                    <select
                      aria-label="Project"
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={line.projectId}
                      onChange={(e) => updateLine(line.key, { projectId: e.target.value })}
                    >
                      <option value="">No project</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>Cost centre (optional)</FieldLabel>
                    <Input
                      aria-label="Cost centre"
                      list="mj-cost-centres"
                      value={line.costCentre}
                      onChange={(e) => updateLine(line.key, { costCentre: e.target.value })}
                      placeholder="e.g. Marketing"
                      className="h-9"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel>GST</FieldLabel>
                      <Input
                        aria-label="GST amount"
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={line.gst}
                        onChange={(e) => updateLine(line.key, { gst: e.target.value })}
                        className="h-9 text-right"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel>TDS</FieldLabel>
                      <Input
                        aria-label="TDS amount"
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={line.tds}
                        onChange={(e) => updateLine(line.key, { tds: e.target.value })}
                        className="h-9 text-right"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
                    <FieldLabel>Line narration (optional)</FieldLabel>
                    <Input
                      aria-label="Line narration"
                      value={line.narration}
                      onChange={(e) => updateLine(line.key, { narration: e.target.value })}
                      placeholder="Describe this line"
                      className="h-9"
                    />
                  </div>
                </div>
              </div>
            ))}
            <datalist id="mj-cost-centres">
              {costCentres.map((cc) => (
                <option key={cc} value={cc} />
              ))}
            </datalist>
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus data-icon="inline-start" />
              Add line
            </Button>
          </div>

          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="mj-narration">Narration</FieldLabel>
            <Textarea
              id="mj-narration"
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              placeholder="Describe the purpose of this journal"
              rows={2}
            />
          </div>

          {/* Phase 31 — the live running validation: total debit, total credit
              and the difference, which must reach zero for the journal to post. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total Debit</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{inr(totalDebit)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total Credit</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{inr(totalCredit)}</div>
            </div>
            <div className={`rounded-md border p-3 ${balanced ? "border-emerald-500/40" : "border-destructive/40"}`}>
              <div className="text-xs text-muted-foreground">Difference</div>
              <div
                className={`mt-1 text-lg font-semibold tabular-nums ${balanced ? "text-emerald-600" : "text-destructive"}`}
              >
                {inr(difference)}
              </div>
            </div>
            <div className="flex flex-col justify-center rounded-md border p-3">
              <div className="text-xs text-muted-foreground">GST / TDS</div>
              <div className="mt-1 text-sm font-medium tabular-nums">
                {inr(totalGst)} / {inr(totalTds)}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end">
            {balanced ? (
              <Badge variant="default">Balanced</Badge>
            ) : (
              <Badge variant="destructive">Out of balance: {inr(Math.abs(difference))}</Badge>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={!!saving}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => save("draft")} disabled={!canSave}>
            {saving === "draft" && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            {isEdit ? "Save changes" : "Save as draft"}
          </Button>
          {!isEdit && (
            <Button onClick={() => save("submit")} disabled={!canSave}>
              {saving === "submit" && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {isAdjust ? `Submit ${adjKind!.toLowerCase()} for approval` : "Submit for approval"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
