"use client"

import { useRef, useState } from "react"
import useSWR from "swr"
import { Download, History, Layers, Loader2, Play, RotateCcw, Undo2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
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
import { parseFile } from "@/components/governance/import-center-panel"
import type { PublicImportDataset } from "@/lib/data-import-catalog"
import type { PublicImportAdapter } from "@/lib/import-adapters"
import type { BatchImportJob } from "@/lib/data-import-batches-store"
import {
  BATCH_IMPORT_STATUS_LABELS,
  BATCH_STAGE_CHUNK_MAX,
  type BatchImportEvent,
  type BatchImportStatus,
} from "@/lib/data-import-batches-model"

const API = "/api/admin/governance/data-import/batches"
const ACTIVE: BatchImportStatus[] = ["queued", "running", "rolling_back"]

type ListResponse = { jobs: BatchImportJob[]; adapters: PublicImportAdapter[] }
type DetailResponse = { job: BatchImportJob; history: BatchImportEvent[] }

const TONE: Partial<Record<BatchImportStatus, "secondary" | "outline" | "destructive">> = {
  completed: "secondary",
  completed_with_errors: "outline",
  failed: "destructive",
  interrupted: "destructive",
  rolled_back: "outline",
}

function newKey() {
  return crypto.randomUUID()
}

async function postJson(url: string, body: unknown, idempotencyKey?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export function BatchImportPanel() {
  const catalogQuery = useSWR<{ catalog: PublicImportDataset[] }>("/api/admin/governance/data-import", fetcher)
  const { data, mutate } = useSWR<ListResponse>(API, fetcher, {
    refreshInterval: (d) => (d?.jobs.some((j) => ACTIVE.includes(j.status)) ? 3000 : 0),
  })
  const [source, setSource] = useState("")
  const [uploading, setUploading] = useState<{ sent: number; total: number } | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<BatchImportJob | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const jobs = data?.jobs ?? []
  const adapters = (data?.adapters ?? []).filter((a) => a.available)
  const importable = catalogQuery.data?.catalog ?? []

  const detail = useSWR<DetailResponse>(selectedId ? `${API}/${selectedId}` : null, fetcher, {
    refreshInterval: (d) => (d && ACTIVE.includes(d.job.status) ? 2000 : 0),
  })
  const selected = detail.data?.job ?? jobs.find((j) => j.id === selectedId) ?? null

  async function refreshAll() {
    await Promise.all([mutate(), detail.mutate()])
  }

  async function handleFile(file: File | null) {
    if (!file) return
    if (!source) {
      toast.error("Choose a target dataset or mapping adapter first.")
      if (inputRef.current) inputRef.current.value = ""
      return
    }
    let parsed
    try {
      parsed = await parseFile(file)
    } catch (err) {
      toast.error(`Could not read file: ${(err as Error).message}`)
      return
    }
    if (parsed.rows.length === 0) {
      toast.error("That file has no data rows.")
      return
    }
    const [kind, key] = source.split(":")
    try {
      setUploading({ sent: 0, total: parsed.rows.length })
      const { job } = (await postJson(
        API,
        {
          datasetKey: kind === "dataset" ? key : undefined,
          adapterKey: kind === "adapter" ? key : null,
          fileName: parsed.fileName,
          headers: parsed.headers,
          totalRows: parsed.rows.length,
        },
        newKey(),
      )) as { job: BatchImportJob }
      // Chunks are keyed by startRow and stored idempotently, so a retry after a
      // dropped connection is safe.
      for (let start = 0; start < parsed.rows.length; start += BATCH_STAGE_CHUNK_MAX) {
        const rows = parsed.rows.slice(start, start + BATCH_STAGE_CHUNK_MAX)
        let attempt = 0
        for (;;) {
          try {
            await postJson(`${API}/${job.id}/rows`, { startRow: start + 1, rows })
            break
          } catch (err) {
            if (++attempt >= 3) throw err
          }
        }
        setUploading({ sent: Math.min(start + rows.length, parsed.rows.length), total: parsed.rows.length })
      }
      await postJson(`${API}/${job.id}/validate`, {})
      setSelectedId(job.id)
      toast.success("File staged and validated. Review the preview, then queue the import.")
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setUploading(null)
      if (inputRef.current) inputRef.current.value = ""
      refreshAll()
    }
  }

  async function act(job: BatchImportJob, action: "start" | "resume" | "rollback" | "validate") {
    setBusy(`${action}:${job.id}`)
    try {
      await postJson(`${API}/${job.id}/${action}`, {}, action === "resume" ? newKey() : undefined)
      toast.success(
        action === "rollback"
          ? "Rollback complete — rows inserted by this import were removed."
          : action === "validate"
            ? "Validation refreshed."
            : "Import queued. Progress updates automatically.",
      )
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
      refreshAll()
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" />
            Large &amp; legacy-system imports
          </CardTitle>
          <CardDescription>
            Queue files with 100k+ rows, or map exports from Tally, HRMS and CRM systems. Rows are uploaded in resumable
            chunks, validated before anything is written, then imported in checkpointed batches in the background.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5 sm:max-w-sm">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="batch-source">
                Target dataset or source adapter
              </label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger id="batch-source">
                  <SelectValue placeholder="Select a target" />
                </SelectTrigger>
                <SelectContent>
                  {importable.map((d) => (
                    <SelectItem key={d.key} value={`dataset:${d.key}`}>
                      {d.label}
                    </SelectItem>
                  ))}
                  {adapters.map((a) => (
                    <SelectItem key={a.key} value={`adapter:${a.key}`}>
                      {a.sourceLabel}: {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.xls,.json"
              className="sr-only"
              id="batch-file"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!source || !!uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              Upload CSV, Excel or JSON
            </Button>
          </div>
          {source.startsWith("adapter:") ? (
            <p className="text-xs text-muted-foreground text-pretty">
              {adapters.find((a) => `adapter:${a.key}` === source)?.description} Expected columns:{" "}
              {adapters
                .find((a) => `adapter:${a.key}` === source)
                ?.sourceHeaders.slice(0, 8)
                .join(", ")}
            </p>
          ) : null}
          {uploading ? (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <Progress value={(uploading.sent / uploading.total) * 100} />
              <p className="text-xs text-muted-foreground">
                Uploading {uploading.sent.toLocaleString()} of {uploading.total.toLocaleString()} rows…
              </p>
            </div>
          ) : null}

          {jobs.length > 0 ? (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="min-w-40">Progress</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id} data-state={job.id === selectedId ? "selected" : undefined}>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left font-medium underline-offset-4 hover:underline"
                          onClick={() => setSelectedId(job.id)}
                        >
                          {job.fileName ?? `Import #${job.id}`}
                        </button>
                        <div className="text-xs text-muted-foreground">{job.datasetLabel}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={TONE[job.status] ?? "outline"}>{BATCH_IMPORT_STATUS_LABELS[job.status]}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {job.importedRows.toLocaleString()} / {job.totalRows.toLocaleString()}
                        {job.failedRows ? (
                          <div className="text-destructive">{job.failedRows.toLocaleString()} failed</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Progress value={job.progressPercent} aria-label={`${job.progressPercent}% complete`} />
                        <div className="mt-1 text-xs text-muted-foreground">
                          Batch {job.processedBatches} of {job.totalBatches}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {job.status === "validated" ? (
                            <Button size="sm" className="gap-1" disabled={!!busy} onClick={() => act(job, "start")}>
                              <Play className="size-3.5" />
                              Queue
                            </Button>
                          ) : null}
                          {job.canResume ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1"
                              disabled={!!busy}
                              onClick={() => act(job, "resume")}
                            >
                              <RotateCcw className="size-3.5" />
                              Resume
                            </Button>
                          ) : null}
                          {job.canRollback ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="gap-1 text-destructive"
                              disabled={!!busy}
                              onClick={() => setRollbackTarget(job)}
                            >
                              <Undo2 className="size-3.5" />
                              Roll back
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No batch imports yet.</p>
          )}
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="size-4 text-muted-foreground" />
              {selected.fileName ?? `Import #${selected.id}`} — preview &amp; history
            </CardTitle>
            <CardDescription>
              {selected.error ? <span className="text-destructive">{selected.error}</span> : selected.datasetLabel}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pt-4">
            {selected.validation ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="secondary">{selected.validation.valid.toLocaleString()} valid</Badge>
                  <Badge variant="destructive">{selected.validation.invalid.toLocaleString()} invalid</Badge>
                  <Badge variant="outline">{selected.validation.duplicate.toLocaleString()} duplicate</Badge>
                  {selected.validation.unmappedRequired.length ? (
                    <Badge variant="destructive">
                      Unmapped required: {selected.validation.unmappedRequired.join(", ")}
                    </Badge>
                  ) : null}
                </div>
                {selected.validation.sample.length ? (
                  <ul className="flex flex-col gap-1 text-xs">
                    {selected.validation.sample.slice(0, 10).map((s) => (
                      <li key={s.rowNumber} className="text-muted-foreground">
                        <span className="font-medium text-foreground">Row {s.rowNumber}</span> ({s.status}):{" "}
                        {s.messages.join("; ")}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" asChild>
                <a href={`${API}/${selected.id}/errors?format=csv`}>
                  <Download className="size-3.5" />
                  Row-level error report (CSV)
                </a>
              </Button>
              {selected.status === "validated" ? (
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act(selected, "validate")}>
                  Re-validate
                </Button>
              ) : null}
            </div>
            {detail.data?.history.length ? (
              <ol className="flex max-h-64 flex-col gap-1.5 overflow-y-auto border-l pl-4 text-xs">
                {detail.data.history.map((e) => (
                  <li key={e.id}>
                    <span className="font-medium">{e.event.replace(/_/g, " ")}</span>
                    {e.batchIndex !== null ? ` · batch ${e.batchIndex + 1}` : ""}
                    <span className="text-muted-foreground"> · {new Date(e.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <AlertDialog open={!!rollbackTarget} onOpenChange={(open) => !open && setRollbackTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back this import?</AlertDialogTitle>
            <AlertDialogDescription>
              Only the {rollbackTarget?.importedRows.toLocaleString()} record(s) created by this import are deleted.
              Records that existed before are never touched. This is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const job = rollbackTarget
                setRollbackTarget(null)
                if (job) act(job, "rollback")
              }}
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
