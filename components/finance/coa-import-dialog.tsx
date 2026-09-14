"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Loader2Icon, Upload, FileDown, CheckCircle2, AlertTriangle } from "lucide-react"
import { readExcelFile, mapRow, downloadExcelTemplate } from "@/lib/excel-import"

type Row = Record<string, any>

type Parsed = {
  account_id: string
  account_code: string
  account_name: string
  account_group: string
  account_type: string
  parent: string
  opening_balance: string
  opening_balance_date: string
  active_status: string
}

type ImportResult = {
  created: number
  updated: number
  failed: number
  errors: { row: number; account: string; message: string }[]
}

const ALIASES: Record<keyof Parsed, string[]> = {
  account_id: ["accountid", "id"],
  account_code: ["accountcode", "code"],
  account_name: ["accountname", "name", "account"],
  account_group: ["accounttype", "type", "group", "accountgroup"],
  account_type: ["subtype", "accountsubtype", "subaccounttype"],
  parent: ["parent", "parentaccount", "parentcode", "parentaccountcode", "parentaccountid"],
  opening_balance: ["openingbalance", "opening"],
  opening_balance_date: ["openingbalancedate", "openingdate", "asondate"],
  active_status: ["status", "activestatus"],
}

const TEMPLATE_HEADERS = [
  "Account Name",
  "Account Code",
  "Account Type",
  "Sub Type",
  "Parent Code",
  "Opening Balance",
  "Opening Balance Date",
  "Status",
]
const TEMPLATE_SAMPLE = [
  "Marketing Expenses",
  "5210",
  "Expense",
  "Operating Expense",
  "5100",
  "0",
  "2026-04-01",
  "Active",
]

export function CoaImportDialog({
  open,
  onOpenChange,
  existingRows,
  onImported,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  existingRows: Row[]
  onImported: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<Parsed[]>([])
  const [fileName, setFileName] = useState("")
  const [parseError, setParseError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  const idSet = new Set(existingRows.map((r) => String(r.account_id)))
  const codeSet = new Set(
    existingRows.filter((r) => r.account_code).map((r) => String(r.account_code).toLowerCase()),
  )

  function reset() {
    setParsed([])
    setFileName("")
    setParseError(null)
    setResult(null)
    if (inputRef.current) inputRef.current.value = ""
  }

  function close(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function onFile(file: File) {
    setParseError(null)
    setResult(null)
    try {
      const raw = await readExcelFile(file)
      const mapped = raw
        .map((r) => mapRow(r, ALIASES))
        .filter((r) => r.account_name || r.account_code)
      if (mapped.length === 0) {
        setParseError("No rows found. Make sure the first row has column headers and there is at least one account.")
        setParsed([])
        return
      }
      setParsed(mapped)
      setFileName(file.name)
    } catch {
      setParseError("Could not read this file. Upload a valid .xlsx, .xls or .csv export.")
      setParsed([])
    }
  }

  function actionFor(row: Parsed): "Update" | "New" {
    const idHit = row.account_id && idSet.has(row.account_id.trim())
    const codeHit = row.account_code && codeSet.has(row.account_code.trim().toLowerCase())
    return idHit || codeHit ? "Update" : "New"
  }

  async function runImport() {
    setImporting(true)
    setParseError(null)
    try {
      const res = await fetch("/api/finance/chart-of-accounts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsed }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setParseError(body.error || "Import failed.")
        return
      }
      setResult(body as ImportResult)
      onImported()
    } catch {
      setParseError("Import request failed. Please try again.")
    } finally {
      setImporting(false)
    }
  }

  const newCount = parsed.filter((r) => actionFor(r) === "New").length
  const updateCount = parsed.length - newCount

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Chart of Accounts</DialogTitle>
          <DialogDescription>
            Upload a spreadsheet of accounts. Existing accounts (matched by Account ID or Code) are updated in place;
            new ones are created with a generated ID. Opening balances are posted to the Journal &amp; General Ledger
            automatically, and account codes / parent hierarchy are validated on import.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => downloadExcelTemplate("chart-of-accounts-template.xlsx", TEMPLATE_HEADERS, TEMPLATE_SAMPLE)}
              >
                <FileDown data-icon="inline-start" />
                Download template
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) onFile(file)
                }}
              />
              <Button variant="outline" onClick={() => inputRef.current?.click()}>
                <Upload data-icon="inline-start" />
                {fileName ? "Choose another file" : "Choose file"}
              </Button>
              {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
            </div>

            {parseError && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertDescription>{parseError}</AlertDescription>
              </Alert>
            )}

            {parsed.length > 0 && (
              <>
                <div className="flex flex-wrap gap-2 text-sm">
                  <Badge variant="secondary">{parsed.length} rows</Badge>
                  <Badge variant="default">{newCount} new</Badge>
                  <Badge variant="outline">{updateCount} update</Badge>
                </div>
                <div className="max-h-72 overflow-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted/60">
                      <tr className="text-left text-muted-foreground">
                        <th className="p-2 font-medium">Action</th>
                        <th className="p-2 font-medium">Name</th>
                        <th className="p-2 font-medium">Code</th>
                        <th className="p-2 font-medium">Type</th>
                        <th className="p-2 font-medium">Parent</th>
                        <th className="p-2 text-right font-medium">Opening</th>
                        <th className="p-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.slice(0, 200).map((r, i) => {
                        const action = actionFor(r)
                        return (
                          <tr key={i} className="border-t">
                            <td className="p-2">
                              <Badge variant={action === "New" ? "default" : "outline"}>{action}</Badge>
                            </td>
                            <td className="p-2 font-medium">{r.account_name || "—"}</td>
                            <td className="p-2 font-mono text-xs">{r.account_code || "—"}</td>
                            <td className="p-2">{r.account_group || "Asset"}</td>
                            <td className="p-2 font-mono text-xs">{r.parent || "—"}</td>
                            <td className="p-2 text-right tabular-nums">{r.opening_balance || "0"}</td>
                            <td className="p-2">{r.active_status || "Active"}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {parsed.length > 200 && (
                  <p className="text-xs text-muted-foreground">
                    Showing the first 200 of {parsed.length} rows. All rows will be imported.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertDescription>
                Import complete — <strong>{result.created}</strong> created, <strong>{result.updated}</strong> updated
                {result.failed > 0 ? (
                  <>
                    , <strong>{result.failed}</strong> skipped
                  </>
                ) : null}
                .
              </AlertDescription>
            </Alert>
            {result.errors.length > 0 && (
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/60">
                    <tr className="text-left text-muted-foreground">
                      <th className="p-2 font-medium">Row</th>
                      <th className="p-2 font-medium">Account</th>
                      <th className="p-2 font-medium">Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((e, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2 tabular-nums">{e.row}</td>
                        <td className="p-2">{e.account}</td>
                        <td className="p-2 text-muted-foreground">{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => close(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)} disabled={importing}>
                Cancel
              </Button>
              <Button onClick={runImport} disabled={parsed.length === 0 || importing}>
                {importing && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                Import {parsed.length > 0 ? `${parsed.length} rows` : ""}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
