"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { AlertCircle, Clock, History, Pause, Play, Plus, Trash2, Zap, Loader2 } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
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
import { ScheduleFormDialog } from "./schedule-form-dialog"
import { ScheduleRunsDialog } from "./schedule-runs-dialog"
import type { ListResponse, ScheduledJob } from "./types"

const STATUS_STYLE: Record<string, string> = {
  succeeded: "bg-emerald-600 hover:bg-emerald-600 text-white",
  running: "bg-blue-600 hover:bg-blue-600 text-white",
  queued: "bg-blue-500/80 hover:bg-blue-500/80 text-white",
  retrying: "bg-amber-500 hover:bg-amber-500 text-white",
  pending: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">Never run</span>
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>
  if (status === "dead_letter") return <Badge variant="destructive">Dead letter</Badge>
  return <Badge className={STATUS_STYLE[status] ?? "bg-muted text-muted-foreground"}>{status.replace(/_/g, " ")}</Badge>
}

function formatDateTime(value: string | null, timezone?: string) {
  if (!value) return "—"
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(value))
  } catch {
    return new Date(value).toLocaleString()
  }
}

export function ScheduledJobsClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>("/api/admin/scheduled-jobs", fetcher)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduledJob | null>(null)
  const [runsFor, setRunsFor] = useState<ScheduledJob | null>(null)
  const [deleting, setDeleting] = useState<ScheduledJob | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const jobs = data?.jobs ?? []
  const metadata = data?.metadata
  const overview = data?.overview ?? {}
  const atLimit = !!metadata && jobs.length >= metadata.limits.maxSchedulesPerTenant

  async function toggleEnabled(job: ScheduledJob) {
    setBusyId(job.id)
    try {
      const res = await fetch(`/api/admin/scheduled-jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !job.enabled, version: job.version }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Failed to update schedule.")
      toast.success(job.enabled ? "Schedule paused." : "Schedule enabled.")
      mutate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update schedule.")
    } finally {
      setBusyId(null)
    }
  }

  async function runNow(job: ScheduledJob) {
    setBusyId(job.id)
    try {
      const res = await fetch(`/api/admin/scheduled-jobs/${job.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Failed to run schedule.")
      toast.success(body.replayed ? "Run already queued." : "Run queued through the shared queue.")
      mutate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to run schedule.")
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusyId(deleting.id)
    try {
      const res = await fetch(`/api/admin/scheduled-jobs/${deleting.id}`, { method: "DELETE" })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Failed to delete schedule.")
      toast.success("Schedule deleted.")
      setDeleting(null)
      mutate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete schedule.")
    } finally {
      setBusyId(null)
    }
  }

  const actionLabel = (key: string) => metadata?.actions.find((a) => a.key === key)?.label ?? key

  if (error) {
    return (
      <Card className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
        <AlertCircle className="h-5 w-5 text-destructive" />
        Failed to load scheduled jobs. You may not have tenant-admin permission.
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {(["succeeded", "failed", "dead_letter", "retrying", "running"] as const).map((key) => (
          <Card key={key} className="flex min-w-32 flex-1 flex-col gap-1 p-4">
            <span className="text-xs capitalize text-muted-foreground">{key.replace(/_/g, " ")} (7d)</span>
            <span className="text-2xl font-semibold tabular-nums">{overview[key] ?? 0}</span>
          </Card>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {jobs.length} of {metadata?.limits.maxSchedulesPerTenant ?? "—"} schedules · concurrency limit{" "}
          {metadata?.limits.concurrencyPerTenant ?? "—"} per tenant
        </div>
        <Button
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
          disabled={atLimit}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          New schedule
        </Button>
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead>Last status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : jobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No scheduled jobs yet. Create one to run a reviewed action on a schedule.
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((job) => (
                <TableRow key={job.id} className={job.enabled ? "" : "opacity-60"}>
                  <TableCell>
                    <div className="font-medium">{job.name}</div>
                    <div className="text-xs text-muted-foreground">{job.timezone}</div>
                  </TableCell>
                  <TableCell className="text-sm">{actionLabel(job.actionKey)}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{job.cronExpression}</code>
                    {!job.enabled && (
                      <Badge variant="outline" className="ml-2">
                        Paused
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {job.enabled ? formatDateTime(job.nextRunAt, job.timezone) : "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={job.lastStatus} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Run now"
                        disabled={busyId === job.id}
                        onClick={() => runNow(job)}
                      >
                        {busyId === job.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={job.enabled ? "Pause" : "Enable"}
                        disabled={busyId === job.id}
                        onClick={() => toggleEnabled(job)}
                      >
                        {job.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="icon" title="Run history" onClick={() => setRunsFor(job)}>
                        <History className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit"
                        onClick={() => {
                          setEditing(job)
                          setFormOpen(true)
                        }}
                      >
                        <Clock className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Delete"
                        className="text-destructive"
                        onClick={() => setDeleting(job)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {metadata && (
        <ScheduleFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          metadata={metadata}
          job={editing}
          onSaved={() => {
            setFormOpen(false)
            mutate()
          }}
        />
      )}

      {runsFor && (
        <ScheduleRunsDialog
          job={runsFor}
          metadata={metadata}
          open={!!runsFor}
          onOpenChange={(open) => !open && setRunsFor(null)}
          onChanged={() => mutate()}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.name} will stop running. Its run history is retained for audit but the schedule cannot be
              recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
