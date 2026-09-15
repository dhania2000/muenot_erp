"use client"

import { useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Upload, FileSpreadsheet, Download, CheckCircle2, AlertTriangle, X } from "lucide-react"
import { inr } from "@/lib/finance-calc"
import { readExcelFile, downloadExcelTemplate } from "@/lib/excel-import"

type Row = Record<string, string>
type ImportResult = { imported: number; failed: number; created: string[]; errors: string[] }

// Each spreadsheet row is one journal LINE. The engine-routed importer groups
// them by the Voucher column and posts each balanced voucher through the same
// accounting engine as a hand-keyed manual journal.
const COLUMNS: Array<{ key: string; label: string; aliases: string[]; type?: "number" | "date"; sample: string }> = [
  { key: "voucher", label: "Voucher", aliases: ["voucher", "voucherno", "voucherid", "jvno", "ref", "batch"], sample: "JV-APR-001" },
  { key: "journal_date", label: "Date", aliases: ["date", "journaldate", "transactiondate", "entrydate"], type: "date", sample: "2026-04-01" },
  { key: "account", label: "Account", aliases: ["account", "accountname", "accountcode", "ledger", "head", "coa"], sample: "Bank" },
  { key: "debit", label: "Debit", aliases: ["debit", "dr", "debitamount"], type: "number", sample: "10000" },
  { key: "credit", label: "Credit", aliases: ["credit", "cr", "creditamount"], type: "number", sample: "0" },
  { key: "narration", label: "Narration", aliases: ["narration", "description", "particulars", "memo"], sample: "Opening balance" },
  { key: "voucher_type", label: "Voucher type", aliases: ["vouchertype", "type", "jvtype"], sample: "Journal" },
  { key: "reference_no", label: "Reference", aliases: ["reference", "referenceno", "refno", "source", "sourceref"], sample: "" },
  { key: "party_id", label: "Party ID", aliases: ["partyid", "party", "customerid", "vendorid", "employeeid"], sample: "" },
  { key: "project_id", label: "Project ID", aliases: ["projectid", "project"], sample: "" },
  { key: "cost_centre", label: "Cost centre", aliases: ["costcentre", "costcenter", "cc"], sample: "" },
  { key: "gst", label: "GST", aliases: ["gst", "gstamount", "tax"], type: "number", sample: "" },
  { key: "tds", label: "TDS", aliases: ["tds", "tdsamount"], type: "number", sample: "" },
]

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function JournalImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState("")
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState("")
  const [parsing, setParsing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  // Map each uploaded row onto our canonical column keys via the alias table.
  const mapped = useMemo(() => {
    return rows.map((row) => {
      const normalized: Record<string, string> = {}
      for (const [k, v] of Object.entries(row)) normalized[normalizeKey(k)] = v
      const out: Record<string, string> = {}
      for (const col of COLUMNS) {
        let value = ""
        for (const alias of col.aliases) {
          if (normalized[alias] !== undefined && normalized[alias] !== "") {
            value = normalized[alias]
            break
          }
        }
        out[col.key] = value
      }
      return out
    })
  }, [rows])

  // Preview grouping mirrors the server: rows collapse into vouchers by the
  // Voucher column, showing the running debit/credit balance per voucher.
  const vouchers = useMemo(() => {
    const map = new Map<string, { label: string; lines: number; debit: number; credit: number }>()
    const order: string[] = []
    mapped.forEach((r, i) => {
      const key = r.voucher?.trim() || `__row_${i}`
      let v = map.get(key)
      if (!v) {
        v = { label: r.voucher?.trim() || `(row ${i + 2})`, lines: 0, debit: 0, credit: 0 }
        map.set(key, v)
        order.push(key)
      }
      v.lines++
      v.debit += Number(String(r.debit).replace(/[^0-9.-]/g, "")) || 0
      v.credit += Number(String(r.credit).replace(/[^0-9.-]/g, "")) || 0
    })
    return order.map((k) => map.get(k)!)
  }, [mapped])

  const balancedCount = vouchers.filter((v) => v.lines >= 2 && Math.abs(v.debit - v.credit) < 0.01).length

  function reset() {
    setFileName("")
    setRows([])
    setError("")
    setResult(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function close() {
    onOpenChange(false)
    setTimeout(reset, 200)
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    setError("")
    setResult(null)
    setParsing(true)
    try {
      const parsed = await readExcelFile(file)
      const nonEmpty = parsed.filter((r) => Object.values(r).some((v) => String(v).trim() !== ""))
      if (!nonEmpty.length) {
        setError("That file has no data rows.")
        setRows([])
      } else {
        setRows(nonEmpty)
        setFileName(file.name)
      }
    } catch {
      setError("Could not read that file. Upload a valid .xlsx, .xls or .csv file.")
      setRows([])
    } finally {
      setParsing(false)
    }
  }

  function downloadTemplate() {
    downloadExcelTemplate(
      "journal-import-template.xlsx",
      COLUMNS.map((c) => c.label),
      COLUMNS.map((c) => c.sample),
    )
  }

  async function submit() {
    setSubmitting(true)
    setError("")
    try {
      const res = await fetch("/api/finance/journal-entries/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: mapped }),
      })
      const data = (await res.json()) as ImportResult & { error?: string }
      if (!res.ok) {
        setError(data.error || "Import failed.")
        return
      }
      setResult(data)
      onImported()
    } catch {
      setError("Import failed. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = rows.length > 0 && vouchers.length > 0 && !submitting

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import journal entries</DialogTitle>
          <DialogDescription>
            Each row is one line; rows are grouped into balanced vouchers by the Voucher column and posted through the
            accounting engine as Draft journals for review.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-4">
            <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4">
              <CheckCircle2 className="mt-0.5 size-5 text-primary" />
              <div className="space-y-1 text-sm">
                <p className="font-medium">
                  Imported {result.imported} voucher{result.imported === 1 ? "" : "s"} as Draft.
                </p>
                {result.failed > 0 && (
                  <p className="text-muted-foreground">{result.failed} voucher(s) were skipped.</p>
                )}
              </div>
            </div>
            {result.errors.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-md border p-3 text-xs text-muted-foreground">
                {result.errors.map((e, i) => (
                  <li key={i} className="py-0.5">
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-5 py-2">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={parsing}>
                <Upload data-icon="inline-start" />
                {parsing ? "Reading…" : "Choose file"}
              </Button>
              <Button variant="ghost" size="sm" onClick={downloadTemplate}>
                <Download data-icon="inline-start" />
                Download template
              </Button>
              {fileName && (
                <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <FileSpreadsheet className="size-4" />
                  {fileName}
                  <button
                    type="button"
                    aria-label="Remove file"
                    onClick={reset}
                    className="rounded p-0.5 hover:bg-muted"
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {vouchers.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Preview</span>
                  <Badge variant="secondary">
                    {vouchers.length} voucher{vouchers.length === 1 ? "" : "s"} · {balancedCount} balanced
                  </Badge>
                </div>
                <div className="max-h-72 overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/60">
                      <tr className="text-left text-muted-foreground">
                        <th className="p-2 font-medium">Voucher</th>
                        <th className="p-2 text-right font-medium">Lines</th>
                        <th className="p-2 text-right font-medium">Debit</th>
                        <th className="p-2 text-right font-medium">Credit</th>
                        <th className="p-2 font-medium">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vouchers.slice(0, 100).map((v, i) => {
                        const balanced = v.lines >= 2 && Math.abs(v.debit - v.credit) < 0.01
                        return (
                          <tr key={i} className="border-t">
                            <td className="p-2 font-mono">{v.label}</td>
                            <td className="p-2 text-right tabular-nums">{v.lines}</td>
                            <td className="p-2 text-right tabular-nums">{inr(v.debit)}</td>
                            <td className="p-2 text-right tabular-nums">{inr(v.credit)}</td>
                            <td className="p-2">
                              {balanced ? (
                                <span className="text-emerald-600">Balanced</span>
                              ) : (
                                <span className="text-destructive">
                                  {v.lines < 2 ? "Needs 2+ lines" : `Off by ${inr(Math.abs(v.debit - v.credit))}`}
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">
                  Unbalanced vouchers are still sent — the engine reports each one it rejects so you can fix and re-import.
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={!canSubmit}>
                {submitting ? "Importing…" : `Import ${vouchers.length || ""} vouchers`.trim()}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
