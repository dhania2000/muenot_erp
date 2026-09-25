"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Loader2, RotateCcw } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import type { JobMetadata, ScheduledJob, ScheduledJobRun } from "./types"

type Props = {
  job: ScheduledJob
  metadata: JobMetadata | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

const STATUS_STYLE: Record<string, string> = {
  succeeded: "bg-emerald-600 hover:bg-emerald-600 text-white",
  running: "bg-blue-600 hover:bg-blue-600 text-white",
  queued: "bg-blue-500/80 hover:bg-blue-500/80 text-white",
  retrying: "bg-amber-500 hover:bg-amber-500 text-white",
}

function StatusBadge({ status }: { status: string }) {
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>
  if (status === "dead_letter") return <Badge variant="destructive">Dead letter</Badge>
  return <Badge className={STATUS_STYLE[status] ?? "bg-muted text-muted-foreground"}>{status.replace(/_/g, " ")}</Badge>
}

function fmt(value: string | null, timezone: string) {
  if (!value) return "—"
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(
      new Date(value),
    )
  } catch {
    return new Date(value).toLocaleString()
  }
}

export function ScheduleRunsDialog({ job, metadata, open, onOpenChange, onChanged }: Props) {
  const { data, isLoading, mutate } = useSWR<{ runs: ScheduledJobRun[] }>(
    open ? `/api/admin/scheduled-jobs/${job.id}/runs` : null,
    fetcher,
  )
  const [retrying, setRetrying] = useState<ScheduledJobRun | null>(null)
  const [busy, setBusy] = useState(false)

  const action = metadata?.actions.find((a) => a.key === job.actionKey)
  const runs = data?.runs ?? []

  async function confirmRetry() {
    if (!retrying) return
    setBusy(true)
    try {
      const res = await fetch(`/api/admin/scheduled-jobs/${job.id}/runs/${retrying.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedAttempt: retrying.attempts,
          acknowledgeUncertain: action ? !action.retrySafe : false,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Failed to retry run.")
      toast.success("Retry queued through the shared queue.")
      setRetrying(null)
      mutate()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to retry run.")
    } finally {
      setBusy(false)
    }
  }

  const canRetry = (run: ScheduledJobRun) => run.status === "failed" || run.status === "dead_letter"

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Run history — {job.name}</DialogTitle>
            <DialogDescription>
              Recent runs with attempts, retries, dead letters and error details. Times shown in {job.timezone}.
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No runs recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {runs.map((run) => (
                <li key={run.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={run.status} />
                        <Badge variant="outline" className="text-xs">
                          {run.triggerSource === "manual" ? "Manual" : "Scheduled"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          attempt {run.attempts}/{run.maxAttempts}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Scheduled for {fmt(run.scheduledFor, job.timezone)}
                        {run.finishedAt && ` · finished ${fmt(run.finishedAt, job.timezone)}`}
                      </div>
                      {run.nextRetryAt && (
                        <div className="text-xs text-amber-600">Next retry {fmt(run.nextRetryAt, job.timezone)}</div>
                      )}
                      {run.skipReason && (
                        <div className="text-xs text-muted-foreground">Skipped: {run.skipReason}</div>
                      )}
                      {run.errorMessage && (
                        <div className="mt-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
                          {run.errorMessage}
                        </div>
                      )}
                    </div>
                    {canRetry(run) && (
                      <Button variant="outline" size="sm" onClick={() => setRetrying(run)}>
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        Retry
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!retrying} onOpenChange={(o) => !o && setRetrying(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry this run?</AlertDialogTitle>
            <AlertDialogDescription>
              {action && !action.retrySafe
                ? "This action has external side effects that may have partially completed. Retrying will run it again — only proceed if you have confirmed it did not deliver."
                : "The run will be re-queued through the shared queue with per-tenant concurrency limits."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRetry} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Retry run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
