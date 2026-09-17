"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Upload } from "lucide-react"

/** Minimal CSV parser that respects quoted fields and commas within quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      field = ""
      if (row.some((c) => c.trim() !== "")) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    if (row.some((c) => c.trim() !== "")) rows.push(row)
  }
  if (rows.length === 0) return []
  const headers = rows[0].map((h) => h.trim())
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => {
      obj[h] = (r[idx] ?? "").trim()
    })
    return obj
  })
}

export function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}) {
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [fileName, setFileName] = useState("")
  const [dedupe, setDedupe] = useState(true)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<any>(null)

  function reset() {
    setRows([])
    setFileName("")
    setReport(null)
  }

  async function handleFile(file: File) {
    const text = await file.text()
    const parsed = parseCsv(text)
    if (parsed.length === 0) {
      toast.error("That file has no rows")
      return
    }
    setFileName(file.name)
    setRows(parsed)
    setReport(null)
  }

  async function runImport() {
    setBusy(true)
    const res = await fetch("/api/marketing/contacts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, dedupe }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      toast.error(data.error || "Import failed")
      return
    }
    setReport(data.report)
    toast.success(`Imported ${data.report.created} · updated ${data.report.updated}`)
    onImported()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>
            Upload a CSV with headers like Email, First Name, Last Name, Company, Phone, Tags. Rows are validated
            individually.
          </DialogDescription>
        </DialogHeader>

        {!report ? (
          <div className="space-y-4">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center transition-colors hover:bg-muted/50">
              <Upload className="size-6 text-muted-foreground" />
              <span className="text-sm font-medium">{fileName || "Choose a CSV file"}</span>
              <span className="text-xs text-muted-foreground">
                {rows.length > 0 ? `${rows.length} rows ready to import` : "Click to browse"}
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleFile(f)
                }}
              />
            </label>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label className="text-sm font-medium">Skip duplicates</Label>
                <p className="text-xs text-muted-foreground">Match on email/phone and update instead of creating.</p>
              </div>
              <Switch checked={dedupe} onCheckedChange={setDedupe} />
            </div>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Created" value={report.created} />
              <Stat label="Updated" value={report.updated} />
              <Stat label="Skipped" value={report.skipped} />
            </div>
            {report.errors?.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-md border p-2 text-xs text-muted-foreground">
                {report.errors.slice(0, 50).map((e: any, i: number) => (
                  <p key={i}>
                    Row {e.row}: {e.message}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {report ? (
            <Button
              onClick={() => {
                reset()
                onOpenChange(false)
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={runImport} disabled={rows.length === 0 || busy}>
                {busy ? "Importing…" : `Import ${rows.length || ""} contacts`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3 text-center">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
