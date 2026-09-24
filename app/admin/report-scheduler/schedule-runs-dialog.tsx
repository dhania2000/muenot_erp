"use client"

import useSWR from "swr"
import { Download } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { ReportSchedule, ReportScheduleRun } from "./types"

type Props = {
  schedule: ReportSchedule
  onClose: () => void
}

type RunsResponse = { schedule: ReportSchedule; runs: ReportScheduleRun[] }

function formatBytes(n: number): string {
  if (n <= 0) return "0 B"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function RunStatusBadge({ status }: { status: ReportScheduleRun["status"] }) {
  if (status === "success") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Success</Badge>
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>
  return <Badge variant="outline">Skipped</Badge>
}

export function ScheduleRunsDialog({ schedule, onClose }: Props) {
  const { data, isLoading } = useSWR<RunsResponse>(`/api/reports/schedules/${schedule.id}`, fetcher, {
    refreshInterval: 5000,
  })
  const runs = data?.runs ?? []

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run history</DialogTitle>
          <DialogDescription>
            {schedule.reportName} · {schedule.description}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex flex-col gap-2 py-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No runs yet. Use &ldquo;Run now&rdquo; or wait for the next scheduled fire.
          </p>
        ) : (
          <ul className="flex flex-col gap-2 py-2">
            {runs.map((run) => (
              <li key={run.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <RunStatusBadge status={run.status} />
                    <span className="text-sm font-medium">
                      {new Date(run.startedAt).toLocaleString()}
                    </span>
                    {run.triggerSource === "manual" && (
                      <Badge variant="outline" className="text-xs">
                        Manual
                      </Badge>
                    )}
                  </div>
                  {run.downloadUrl && (
                    <Button asChild variant="outline" size="sm">
                      <a href={run.downloadUrl}>
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                        Download
                      </a>
                    </Button>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{run.format.toUpperCase()}</span>
                  <span>{run.channel === "email" ? "Email" : "Storage"}</span>
                  {run.status === "success" && (
                    <>
                      <span>{run.rowCount.toLocaleString()} rows</span>
                      <span>{formatBytes(run.byteSize)}</span>
                      {run.channel === "email" && <span>{run.recipientsCount} recipients</span>}
                    </>
                  )}
                </div>
                {run.error && <p className="mt-1.5 text-xs text-destructive">{run.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
