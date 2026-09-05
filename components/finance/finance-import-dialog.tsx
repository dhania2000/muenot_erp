"use client"

import { useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
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
import type { ModuleConfig } from "@/lib/finance-schema"

type Row = Record<string, string>
type Account = { id: number; finance_account_id: string; account_name: string; bank_name?: string }
type ImportResult = { imported: number; failed: number; errors: string[] }

/** Normalizes a spreadsheet header the same way the alias tables expect. */
function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function FinanceImportDialog({
  cfg,
  open,
  onOpenChange,
  onImported,
}: {
  cfg: ModuleConfig
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}) {
  const spec = cfg.importSpec
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState("")
  const [rows, setRows] = useState<Row[]>([])
  const [accountId, setAccountId] = useState("")
  const [error, setError] = useState("")
  const [parsing, setParsing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  const { data: accountData } = useSWR<{ rows: Account[] }>(
    open && spec?.accountBound ? "/api/finance/module/bank-cash" : null,
    fetcher,
  )
  const accounts = accountData?.rows ?? []
  const selectedAccount = accounts.find((a) => String(a.id) === accountId)

  // Map every uploaded row onto the module's canonical column keys via aliases.
  const mapped = useMemo(() => {
    if (!spec) return []
    return rows.map((row) => {
      const normalized: Record<string, string> = {}
      for (const [k, v] of Object.entries(row)) normalized[normalizeKey(k)] = v
      const out: Record<string, string> = {}
      for (const col of spec.columns) {
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
  }, [rows, spec])

  if (!spec) return null

  function reset() {
    setFileName("")
    setRows([])
    setError("")
    setResult(null)
    setAccountId("")
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function close() {
    onOpenChange(false)
    // Delay reset so it doesn't flash while the dialog animates out.
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
      setError("Could not read that file. Upload a valid .xlsx, .xls or .csv statement.")
      setRows([])
    } finally {
      setParsing(false)
    }
  }

  function downloadTemplate() {
    downloadExcelTemplate(
      spec!.templateName,
      spec!.columns.map((c) => c.label),
      spec!.columns.map((c) =>
        c.type === "date" ? "2026-04-01" : c.type === "number" ? "0" : "",
      ),
    )
  }

  const recognizedCount = useMemo(
    () => mapped.filter((r) => r.transaction_date || Number(r.debit) || Number(r.credit)).length,
    [mapped],
  )

  async function submit() {
    setSubmitting(true)
    setError("")
    try {
      const res = await fetch(`/api/finance/module/${cfg.key}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: mapped,
          account: selectedAccount
            ? { bank_cash_account_id: selectedAccount.finance_account_id, account_name: selectedAccount.account_name }
            : undefined,
        }),
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

  const canSubmit =
    rows.length > 0 &&
    recognizedCount > 0 &&
    (!spec.accountBound || !!selectedAccount) &&
    !submitting

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{spec.title}</DialogTitle>
          <DialogDescription>{spec.description}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-4">
            <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4">
              <CheckCircle2 className="mt-0.5 size-5 text-primary" />
              <div className="space-y-1 text-sm">
                <p className="font-medium">
                  Imported {result.imported} transaction{result.imported === 1 ? "" : "s"}
                  {selectedAccount ? ` into ${selectedAccount.account_name}` : ""}.
                </p>
                {result.failed > 0 && (
                  <p className="text-muted-foreground">{result.failed} row(s) were skipped.</p>
                )}
              </div>
            </div>
            {result.errors.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-md border p-3 text-xs text-muted-foreground">
                {result.errors.map((e, i) => (
                  <li key={i} className="py-0.5">{e}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-5 py-2">
            {spec.accountBound && (
              <div className="space-y-1.5">
                <label htmlFor="import-account" className="text-sm font-medium">
                  Bank / Cash account <span className="text-destructive">*</span>
                </label>
                <select
                  id="import-account"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  <option value="">Select the account this statement belongs to…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_name}{a.bank_name ? ` — ${a.bank_name}` : ""}
                    </option>
                  ))}
                </select>
                {accounts.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No accounts yet. Add one under Bank &amp; Cash first.
                  </p>
                )}
              </div>
            )}

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
                {parsing ? "Reading…" : "Choose statement file"}
              </Button>
              <Button variant="ghost" size="sm" onClick={downloadTemplate}>
                <Download data-icon="inline-start" />
                Download template
              </Button>
              {fileName && (
                <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <FileSpreadsheet className="size-4" />
                  {fileName}
                  <button type="button" aria-label="Remove file" onClick={reset} className="rounded p-0.5 hover:bg-muted">
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

            {rows.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Preview</span>
                  <Badge variant="secondary">
                    {recognizedCount} of {rows.length} rows ready
                  </Badge>
                </div>
                <div className="max-h-72 overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/60">
                      <tr className="text-left text-muted-foreground">
                        {spec.columns.map((c) => (
                          <th key={c.key} className={`whitespace-nowrap p-2 font-medium ${c.type === "number" ? "text-right" : ""}`}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {mapped.slice(0, 100).map((row, i) => (
                        <tr key={i} className="border-t">
                          {spec.columns.map((c) => (
                            <td key={c.key} className={`whitespace-nowrap p-2 ${c.type === "number" ? "text-right tabular-nums" : ""}`}>
                              {row[c.key]
                                ? c.type === "number"
                                  ? inr(row[c.key])
                                  : row[c.key]
                                : <span className="text-muted-foreground">—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > 100 && (
                  <p className="text-xs text-muted-foreground">Showing first 100 rows. All {rows.length} will be imported.</p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button onClick={submit} disabled={!canSubmit}>
                {submitting ? "Importing…" : `Import ${recognizedCount || ""} transactions`.trim()}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
