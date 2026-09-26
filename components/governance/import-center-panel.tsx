"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileWarning,
  Loader2,
  Undo2,
  Upload,
} from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { fetcher } from "@/lib/fetcher"
import { readExcelFile } from "@/lib/excel-import"
import type { PublicImportDataset } from "@/lib/data-import-catalog"
import type { ImportAnalysis, ImportJobStatus, ImportJobSummary, ImportRowStatus } from "@/lib/data-import-model"

const API = "/api/admin/governance/data-import"
const NOT_MAPPED = "__none__"

type ApiResponse = {
  jobs: ImportJobSummary[]
  catalog: PublicImportDataset[]
  rowLimit: number
  statusLabels: Record<ImportJobStatus, string>
}

type ParsedFile = {
  fileName: string
  headers: string[]
  rows: Record<string, unknown>[]
}

const STATUS_TONE: Record<ImportJobStatus, "secondary" | "outline" | "destructive"> = {
  completed: "secondary",
  completed_with_errors: "outline",
  failed: "destructive",
  rolled_back: "destructive",
}

const ROW_TONE: Record<ImportRowStatus, "secondary" | "outline" | "destructive"> = {
  valid: "secondary",
  error: "destructive",
  duplicate: "outline",
}

function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString()
}

/** Parse a browser File (CSV / Excel / JSON) into headers + raw row objects. */
export async function parseFile(file: File): Promise<ParsedFile> {
  const name = file.name.toLowerCase()
  let rows: Record<string, unknown>[]
  if (name.endsWith(".json")) {
    const text = await file.text()
    const data = JSON.parse(text)
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { data?: unknown })?.data)
        ? (data as { data: unknown[] }).data
        : Array.isArray((data as { records?: unknown })?.records)
          ? (data as { records: unknown[] }).records
          : null
    if (!list) throw new Error("JSON must be an array of objects (or { data: [...] }).")
    rows = list.map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : { value: r }))
  } else {
    rows = await readExcelFile(file)
  }
  // Union of keys across rows preserves columns that are empty in the first row.
  const headerSet = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) headerSet.add(k)
  return { fileName: file.name, headers: Array.from(headerSet), rows }
}

export function ImportCenterPanel() {
  const { data, error, isLoading, mutate } = useSWR<ApiResponse>(API, fetcher)
  const [datasetKey, setDatasetKey] = useState("")
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [rollingBackId, setRollingBackId] = useState<number | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<ImportJobSummary | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const catalog = data?.catalog ?? []
  const jobs = data?.jobs ?? []
  const statusLabels = data?.statusLabels
  const rowLimit = data?.rowLimit ?? 20000

  const selectedDataset = useMemo(
    () => catalog.find((c) => c.key === datasetKey),
    [catalog, datasetKey],
  )

  const runAnalysis = useCallback(
    async (key: string, file: ParsedFile, map?: Record<string, string | null>) => {
      setAnalyzing(true)
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            datasetKey: key,
            headers: file.headers,
            rows: file.rows,
            mapping: map,
            fileName: file.fileName,
          }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || "Validation failed")
        const result = body.analysis as ImportAnalysis
        setAnalysis(result)
        setMapping(result.mapping)
        return result
      } catch (err) {
        toast.error((err as Error).message)
        return null
      } finally {
        setAnalyzing(false)
      }
    },
    [],
  )

  function resetWizard() {
    setParsed(null)
    setAnalysis(null)
    setMapping({})
    if (inputRef.current) inputRef.current.value = ""
  }

  async function handleFile(file: File | null) {
    if (!file) return
    if (!datasetKey) {
      toast.error("Choose a target dataset first.")
      if (inputRef.current) inputRef.current.value = ""
      return
    }
    let file0: ParsedFile
    try {
      file0 = await parseFile(file)
    } catch (err) {
      toast.error(`Could not read file: ${(err as Error).message}`)
      return
    }
    if (file0.rows.length === 0) {
      toast.error("That file has no data rows.")
      return
    }
    setParsed(file0)
    await runAnalysis(datasetKey, file0)
  }

  async function handleDatasetChange(key: string) {
    setDatasetKey(key)
    resetWizard()
  }

  async function handleMappingChange(columnKey: string, header: string) {
    if (!parsed) return
    const next = { ...mapping, [columnKey]: header === NOT_MAPPED ? null : header }
    setMapping(next)
    await runAnalysis(datasetKey, parsed, next)
  }

  async function commitImport() {
    if (!parsed || !analysis) return
    setImporting(true)
    try {
      const res = await fetch(`${API}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasetKey,
          headers: parsed.headers,
          rows: parsed.rows,
          mapping,
          fileName: parsed.fileName,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Import failed")
      const job = body.job as ImportJobSummary
      if (job.status === "failed") {
        toast.error(`Import failed — 0 of ${job.totalRows} row(s) imported.`)
      } else {
        toast.success(
          `Imported ${job.importedRows} of ${job.totalRows} row(s)` +
            (job.skippedRows ? `, ${job.skippedRows} skipped` : "") +
            (job.failedRows ? `, ${job.failedRows} failed` : "") +
            ".",
        )
      }
      resetWizard()
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setImporting(false)
    }
  }

  async function confirmRollback() {
    if (!rollbackTarget) return
    const jobId = rollbackTarget.id
    setRollingBackId(jobId)
    setRollbackTarget(null)
    try {
      const res = await fetch(`${API}/${jobId}/rollback`, { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Rollback failed")
      toast.success("Import rolled back — inserted rows removed.")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setRollingBackId(null)
    }
  }

  const canImport = Boolean(analysis?.canImport) && !analyzing && !importing

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-4 text-muted-foreground" />
            New import
          </CardTitle>
          <CardDescription>
            Upload a CSV, Excel, or JSON file, map its columns to a module dataset, then validate and preview before
            committing. Imports are tenant-scoped, deduplicated against existing records, and can be rolled back.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 pt-4">
          {error ? (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          ) : (
            <>
              {/* Step 1 — dataset + file */}
              <div className="grid gap-3 sm:grid-cols-2 sm:max-w-2xl">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="import-dataset">
                    Target dataset
                  </label>
                  <Select value={datasetKey} onValueChange={handleDatasetChange} disabled={isLoading}>
                    <SelectTrigger id="import-dataset">
                      <SelectValue placeholder="Select a dataset" />
                    </SelectTrigger>
                    <SelectContent>
                      {catalog.map((d) => (
                        <SelectItem key={d.key} value={d.key}>
                          {d.label} · {d.module}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">File</span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      className="gap-1.5"
                      disabled={!datasetKey}
                      onClick={() => inputRef.current?.click()}
                    >
                      <Upload className="size-3.5" />
                      {parsed ? "Replace file" : "Choose file"}
                    </Button>
                    {parsed ? (
                      <span className="truncate text-xs text-muted-foreground" title={parsed.fileName}>
                        {parsed.fileName} · {parsed.rows.length.toLocaleString()} row(s)
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">.csv, .xlsx, .json</span>
                    )}
                    <input
                      ref={inputRef}
                      type="file"
                      accept=".csv,.xlsx,.xls,.json"
                      className="hidden"
                      onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                    />
                  </div>
                </div>
              </div>

              {selectedDataset ? (
                <p className="text-xs text-muted-foreground">
                  Duplicate detection keys:{" "}
                  {selectedDataset.dedupeKeys.length > 0
                    ? selectedDataset.dedupeKeys
                        .map((k) => selectedDataset.columns.find((c) => c.key === k)?.label ?? k)
                        .join(", ")
                    : "none"}
                  .
                </p>
              ) : null}

              {analyzing && !analysis ? <Skeleton className="h-40 w-full" /> : null}

              {/* Step 2 — mapping */}
              {parsed && analysis ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">Column mapping</h3>
                    {analyzing ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> Validating…
                      </span>
                    ) : null}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {analysis.columns.map((col) => {
                      const isUnmappedRequired = analysis.unmappedRequired.includes(col.key)
                      return (
                        <div key={col.key} className="flex items-center gap-2">
                          <div className="flex w-40 shrink-0 flex-col">
                            <span className="truncate text-xs font-medium" title={col.label}>
                              {col.label}
                              {col.required ? <span className="text-destructive"> *</span> : null}
                            </span>
                            <span className="text-[10px] uppercase text-muted-foreground">{col.type}</span>
                          </div>
                          <Select
                            value={mapping[col.key] ?? NOT_MAPPED}
                            onValueChange={(v) => handleMappingChange(col.key, v)}
                          >
                            <SelectTrigger
                              className={isUnmappedRequired ? "border-destructive" : ""}
                              aria-label={`Source column for ${col.label}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NOT_MAPPED}>— Not mapped —</SelectItem>
                              {parsed.headers.map((h) => (
                                <SelectItem key={h} value={h}>
                                  {h}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              {/* Step 3 — validation summary */}
              {analysis ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="secondary" className="gap-1">
                      <CheckCircle2 className="size-3" />
                      {analysis.validRows} valid
                    </Badge>
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="size-3" />
                      {analysis.errorRows} error
                    </Badge>
                    <Badge variant="outline" className="gap-1">
                      <Copy className="size-3" />
                      {analysis.duplicateRows} duplicate
                    </Badge>
                    <Badge variant="outline">{analysis.totalRows} total</Badge>
                  </div>

                  {analysis.unmappedRequired.length > 0 ? (
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <AlertTriangle className="size-3.5" />
                      Map required column(s):{" "}
                      {analysis.unmappedRequired
                        .map((k) => analysis.columns.find((c) => c.key === k)?.label ?? k)
                        .join(", ")}
                    </p>
                  ) : null}

                  {analysis.truncated ? (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      File was clipped to the first {rowLimit.toLocaleString()} rows. Split larger files into batches.
                    </p>
                  ) : null}

                  {/* Preview */}
                  {analysis.preview.length > 0 ? (
                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">Row</TableHead>
                            <TableHead className="w-24">Status</TableHead>
                            {analysis.columns.map((c) => (
                              <TableHead key={c.key} className="whitespace-nowrap">
                                {c.label}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {analysis.preview.map((r) => (
                            <TableRow key={r.row}>
                              <TableCell className="text-xs text-muted-foreground">{r.row}</TableCell>
                              <TableCell>
                                <Badge variant={ROW_TONE[r.status]} className="text-[10px] capitalize">
                                  {r.status}
                                </Badge>
                                {r.messages.length > 0 ? (
                                  <span
                                    className="mt-0.5 block max-w-[160px] truncate text-[10px] text-muted-foreground"
                                    title={r.messages.join("; ")}
                                  >
                                    {r.messages.join("; ")}
                                  </span>
                                ) : null}
                              </TableCell>
                              {analysis.columns.map((c) => (
                                <TableCell key={c.key} className="whitespace-nowrap text-xs">
                                  {r.values[c.key] ?? ""}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : null}
                  {analysis.totalRows > analysis.preview.length ? (
                    <p className="text-[11px] text-muted-foreground">
                      Showing the first {analysis.preview.length} of {analysis.totalRows} rows.
                    </p>
                  ) : null}

                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={resetWizard} disabled={importing}>
                      Cancel
                    </Button>
                    <Button className="gap-1.5" onClick={commitImport} disabled={!canImport}>
                      {importing ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                      Import {analysis.validRows} valid row(s)
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Import history</CardTitle>
          <CardDescription>
            Every import is recorded. Download a row-level error report, or roll back a completed import to remove the
            rows it inserted.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dataset</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Imported</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Skipped</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>By</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={9}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                    No imports yet. Upload a file above to get started.
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="text-sm">{j.datasetLabel}</TableCell>
                    <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground" title={j.fileName ?? ""}>
                      {j.fileName ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">{j.importedRows.toLocaleString()}</TableCell>
                    <TableCell className="text-xs">{j.failedRows.toLocaleString()}</TableCell>
                    <TableCell className="text-xs">{j.skippedRows.toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_TONE[j.status]} className="text-[10px]">
                        {statusLabels?.[j.status] ?? j.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{j.requestedByName ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(j.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {j.errorCount > 0 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1"
                            asChild
                            title={`${j.errorCount} issue(s)`}
                          >
                            <a href={`${API}/${j.id}/error-report`}>
                              <FileWarning className="size-3.5" />
                              Errors
                            </a>
                          </Button>
                        ) : null}
                        {j.rollbackable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1 text-destructive"
                            onClick={() => setRollbackTarget(j)}
                            disabled={rollingBackId === j.id}
                          >
                            {rollingBackId === j.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Undo2 className="size-3.5" />
                            )}
                            Roll back
                          </Button>
                        ) : null}
                        {j.errorCount === 0 && !j.rollbackable ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog open={rollbackTarget !== null} onOpenChange={(open) => !open && setRollbackTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back this import?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the {rollbackTarget?.importedRows.toLocaleString()} row(s) that{" "}
              {rollbackTarget?.datasetLabel} inserted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRollback}>Roll back</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
