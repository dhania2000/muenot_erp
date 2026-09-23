"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { CalendarClock, Download, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react"
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
import type { PublicExportDataset } from "@/lib/data-export-catalog"
import type { ExportFormat, ExportFrequency, ExportStatus } from "@/lib/data-export-model"

const API = "/api/admin/governance/export"
const SCHEDULES_API = "/api/admin/governance/export/schedules"

type ExportJob = {
  id: number
  datasetKey: string
  scopeLabel: string
  format: ExportFormat
  status: ExportStatus
  rowCount: number
  redactedFields: string[]
  fileName: string | null
  byteSize: number
  triggerSource: "manual" | "scheduler"
  scheduleId: number | null
  requestedByName: string | null
  error: string | null
  expiresAt: string | null
  createdAt: string
  finishedAt: string | null
  downloadPath?: string | null
}

type ExportSchedule = {
  id: number
  datasetKey: string
  scopeLabel: string
  format: ExportFormat
  frequency: ExportFrequency
  status: "active" | "paused"
  lastRunAt: string | null
  nextRunAt: string | null
  createdByName: string | null
  createdAt: string
}

type ApiResponse = {
  jobs: ExportJob[]
  schedules: ExportSchedule[]
  catalog: PublicExportDataset[]
  fullTenantKey: string
  formats: Record<ExportFormat, string>
  frequencies: ExportFrequency[]
}

const STATUS_TONE: Record<ExportStatus, "secondary" | "outline" | "destructive"> = {
  queued: "outline",
  running: "outline",
  completed: "secondary",
  failed: "destructive",
  expired: "destructive",
}

function formatBytes(bytes: number): string {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString()
}

export function ExportCenterPanel() {
  const { data, error, isLoading, mutate } = useSWR<ApiResponse>(API, fetcher)
  const [scope, setScope] = useState<string>("")
  const [format, setFormat] = useState<ExportFormat>("csv")
  const [frequency, setFrequency] = useState<ExportFrequency>("weekly")
  const [running, setRunning] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [downloadingId, setDownloadingId] = useState<number | null>(null)
  const [deletingSchedule, setDeletingSchedule] = useState<ExportSchedule | null>(null)

  const jobs = data?.jobs ?? []
  const schedules = data?.schedules ?? []
  const catalog = data?.catalog ?? []
  const fullTenantKey = data?.fullTenantKey ?? "__full_tenant__"
  const formats = data?.formats
  const frequencies = data?.frequencies ?? (["daily", "weekly", "monthly"] as ExportFrequency[])

  // Resolve the effective scope: default to the first catalog dataset once loaded.
  const effectiveScope = scope || catalog[0]?.key || ""

  const selectedDataset = useMemo(
    () => (effectiveScope === fullTenantKey ? null : catalog.find((c) => c.key === effectiveScope)),
    [catalog, effectiveScope, fullTenantKey],
  )

  // PDF is only meaningful for eligible datasets and never for a full-tenant export.
  const pdfDisabled = effectiveScope === fullTenantKey || (selectedDataset ? !selectedDataset.pdfEligible : false)
  const formatEntries = (Object.entries(formats ?? { csv: "CSV", xlsx: "Excel", json: "JSON", pdf: "PDF" }) as [
    ExportFormat,
    string,
  ][]).filter(([f]) => !(f === "pdf" && pdfDisabled))

  async function startExport() {
    if (!effectiveScope) {
      toast.error("Choose a dataset or full-tenant scope first.")
      return
    }
    const useFormat = format === "pdf" && pdfDisabled ? "csv" : format
    setRunning(true)
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetKey: effectiveScope, format: useFormat }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Export failed")
      const job = body.job as ExportJob
      if (job?.status === "failed") {
        toast.error(job.error || "Export failed.")
      } else {
        toast.success(
          `Export ready — ${job.rowCount} record(s)${job.redactedFields.length ? `, ${job.redactedFields.length} field(s) redacted` : ""}.`,
        )
      }
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  async function scheduleExport() {
    if (!effectiveScope) {
      toast.error("Choose a dataset or full-tenant scope first.")
      return
    }
    const useFormat = format === "pdf" && pdfDisabled ? "csv" : format
    setScheduling(true)
    try {
      const res = await fetch(SCHEDULES_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetKey: effectiveScope, format: useFormat, frequency }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Could not create schedule")
      toast.success("Recurring export scheduled.")
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setScheduling(false)
    }
  }

  async function downloadJob(job: ExportJob) {
    setDownloadingId(job.id)
    try {
      // Always fetch a fresh signed link at download time — links are
      // permission-checked and expiring, so we never trust a stale one.
      const res = await fetch(`${API}/${job.id}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Could not prepare download")
      const path = (body.job as ExportJob)?.downloadPath
      if (!path) throw new Error("This export is no longer available for download.")
      window.location.href = path
    } catch (err) {
      toast.error((err as Error).message)
      mutate()
    } finally {
      setDownloadingId(null)
    }
  }

  async function confirmDeleteSchedule() {
    if (!deletingSchedule) return
    try {
      const res = await fetch(`${SCHEDULES_API}/${deletingSchedule.id}`, { method: "DELETE" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Could not delete schedule")
      }
      toast.success("Schedule removed.")
      setDeletingSchedule(null)
      mutate()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Download className="size-4 text-muted-foreground" />
            New export
          </CardTitle>
          <CardDescription>
            Export a single module dataset or the full tenant. Every export is tenant-scoped, redacts fields your role
            may not export, and produces an expiring, permission-checked download link.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          {error ? (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3 sm:max-w-2xl">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="export-scope">
                    Dataset / scope
                  </label>
                  <Select value={effectiveScope} onValueChange={setScope} disabled={isLoading}>
                    <SelectTrigger id="export-scope">
                      <SelectValue placeholder="Select a dataset" />
                    </SelectTrigger>
                    <SelectContent>
                      {catalog.map((d) => (
                        <SelectItem key={d.key} value={d.key}>
                          {d.label} · {d.module}
                        </SelectItem>
                      ))}
                      <SelectItem value={fullTenantKey}>Full tenant export</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="export-format">
                    Format
                  </label>
                  <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)} disabled={isLoading}>
                    <SelectTrigger id="export-format">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {formatEntries.map(([f, label]) => (
                        <SelectItem key={f} value={f}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="export-frequency">
                    Schedule frequency
                  </label>
                  <Select
                    value={frequency}
                    onValueChange={(v) => setFrequency(v as ExportFrequency)}
                    disabled={isLoading}
                  >
                    <SelectTrigger id="export-frequency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {frequencies.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f.charAt(0).toUpperCase() + f.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {selectedDataset ? (
                <p className="text-xs text-muted-foreground">{selectedDataset.description}</p>
              ) : effectiveScope === fullTenantKey ? (
                <p className="text-xs text-muted-foreground">
                  Exports every available dataset across all modules into a single archive.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="gap-1.5" onClick={startExport} disabled={running || isLoading}>
                  {running ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  Start export
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={scheduleExport}
                  disabled={scheduling || isLoading}
                >
                  {scheduling ? <Loader2 className="size-3.5 animate-spin" /> : <CalendarClock className="size-3.5" />}
                  Schedule recurring export
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Export jobs</CardTitle>
          <CardDescription>Download links expire and are permission-checked at access time.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Records</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">File</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No exports yet. Start one above.
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="text-sm">
                      <div className="flex items-center gap-1.5">
                        {j.scopeLabel}
                        {j.triggerSource === "scheduler" ? (
                          <Badge variant="outline" className="text-[9px]">
                            Scheduled
                          </Badge>
                        ) : null}
                      </div>
                      {j.redactedFields.length > 0 ? (
                        <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                          <ShieldAlert className="size-3" />
                          {j.redactedFields.length} field(s) redacted
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs uppercase text-muted-foreground">{j.format}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {j.status === "completed" ? j.rowCount.toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{j.requestedByName ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_TONE[j.status]} className="text-[10px] capitalize">
                        {j.status}
                      </Badge>
                      {j.status === "failed" && j.error ? (
                        <span className="mt-0.5 block max-w-[200px] truncate text-[10px] text-destructive" title={j.error}>
                          {j.error}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(j.expiresAt)}</TableCell>
                    <TableCell className="text-right">
                      {j.status === "completed" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          onClick={() => downloadJob(j)}
                          disabled={downloadingId === j.id}
                        >
                          {downloadingId === j.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Download className="size-3.5" />
                          )}
                          <span className="max-w-[160px] truncate">{j.fileName ?? "Download"}</span>
                          <span className="text-[10px] text-muted-foreground">({formatBytes(j.byteSize)})</span>
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CalendarClock className="size-4 text-muted-foreground" />
            Scheduled exports
          </CardTitle>
          <CardDescription>
            Recurring exports run unattended and appear in the jobs list as they complete.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 2 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : schedules.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No scheduled exports.
                  </TableCell>
                </TableRow>
              ) : (
                schedules.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-sm">{s.scopeLabel}</TableCell>
                    <TableCell className="text-xs uppercase text-muted-foreground">{s.format}</TableCell>
                    <TableCell className="text-xs capitalize text-muted-foreground">{s.frequency}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(s.lastRunAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(s.nextRunAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.createdByName ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete schedule for ${s.scopeLabel}`}
                        onClick={() => setDeletingSchedule(s)}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog open={deletingSchedule !== null} onOpenChange={(open) => !open && setDeletingSchedule(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete scheduled export?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the recurring export for {deletingSchedule?.scopeLabel}. Existing generated files are not
              affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteSchedule}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
