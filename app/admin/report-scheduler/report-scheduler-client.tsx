"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  AlertCircle,
  CalendarClock,
  History,
  Mail,
  Pause,
  Play,
  Plus,
  Trash2,
  HardDriveDownload,
  Loader2,
} from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
import type { ReportSchedule, SchedulerMetadata } from "./types"

type ListResponse = {
  schedules: ReportSchedule[]
  reports: { id: number; name: string; sourceKey: string }[]
  metadata: SchedulerMetadata
}

const FORMAT_BADGE: Record<string, string> = {
  pdf: "PDF",
  xlsx: "Excel",
  csv: "CSV",
}

function LastStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">Never run</span>
  if (status === "success") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Success</Badge>
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>
  return <Badge variant="outline">{status}</Badge>
}

export function ReportSchedulerClient() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>("/api/reports/schedules", fetcher)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ReportSchedule | null>(null)
  const [viewingRuns, setViewingRuns] = useState<ReportSchedule | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const schedules = useMemo(() => data?.schedules ?? [], [data])
  const reports = useMemo(() => data?.reports ?? [], [data])

  async function toggleStatus(schedule: ReportSchedule) {
    const next = schedule.status === "active" ? "paused" : "active"
    setBusyId(schedule.id)
    try {
      const res = await fetch(`/api/reports/schedules/${schedule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to update")
      toast.success(next === "active" ? "Schedule resumed" : "Schedule paused")
      void mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function runNow(schedule: ReportSchedule) {
    setBusyId(schedule.id)
    try {
      const res = await fetch(`/api/reports/schedules/${schedule.id}/run`, { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Failed to run")
      if (body.status === "success") toast.success("Report generated and delivered")
      else if (body.status === "skipped") toast.message("Already ran for this minute — try again shortly")
      else toast.error(body.error || "Run failed")
      void mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusyId(deleting.id)
    try {
      const res = await fetch(`/api/reports/schedules/${deleting.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to delete")
      toast.success("Schedule deleted")
      setDeleting(null)
      void mutate()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  if (error) {
    return (
      <Card className="flex items-center gap-3 p-6 text-sm">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <span>You do not have access to the report scheduler, or it failed to load.</span>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {schedules.length} schedule{schedules.length === 1 ? "" : "s"}
        </p>
        <Button onClick={() => setCreating(true)} disabled={!data}>
          <Plus className="mr-1.5 h-4 w-4" />
          New schedule
        </Button>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center">
            <CalendarClock className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No scheduled reports yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {reports.length === 0
                ? "Save a report in the report builder first, then schedule it here."
                : "Create a schedule to have a saved report delivered automatically."}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Report</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-40 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="font-medium">{s.reportName}</div>
                    <div className="text-xs text-muted-foreground">{s.timezone}</div>
                  </TableCell>
                  <TableCell className="text-sm">
                    <div>{s.description}</div>
                    <div className="font-mono text-xs text-muted-foreground">{s.cronExpression}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-sm">
                      {s.channel === "email" ? (
                        <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <HardDriveDownload className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <Badge variant="secondary">{FORMAT_BADGE[s.format] ?? s.format}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {s.channel === "email"
                        ? `${s.recipients.length} recipient${s.recipients.length === 1 ? "" : "s"}`
                        : "Secure download link"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <LastStatusBadge status={s.lastStatus} />
                    {s.lastRunAt && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {new Date(s.lastRunAt).toLocaleString()}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {s.status === "active" ? (
                      <Badge className="bg-emerald-600 hover:bg-emerald-600">Active</Badge>
                    ) : (
                      <Badge variant="outline">Paused</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Run ${s.reportName} now`}
                        disabled={busyId === s.id}
                        onClick={() => runNow(s)}
                      >
                        {busyId === s.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`View run history for ${s.reportName}`}
                        onClick={() => setViewingRuns(s)}
                      >
                        <History className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={s.status === "active" ? `Pause ${s.reportName}` : `Resume ${s.reportName}`}
                        disabled={busyId === s.id}
                        onClick={() => toggleStatus(s)}
                      >
                        {s.status === "active" ? (
                          <Pause className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete schedule for ${s.reportName}`}
                        onClick={() => setDeleting(s)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {data && creating && (
        <ScheduleFormDialog
          reports={reports}
          metadata={data.metadata}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            void mutate()
          }}
        />
      )}

      {viewingRuns && (
        <ScheduleRunsDialog schedule={viewingRuns} onClose={() => setViewingRuns(null)} />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `The schedule for "${deleting.reportName}" and its run history will be permanently removed. This does not delete the report itself.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void confirmDelete()
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
