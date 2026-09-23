"use client"

/**
 * reusable bulk-action bar.
 *
 * Drop-in toolbar shown while table rows are selected. It talks to the generic
 * `/api/bulk/[resource]` endpoint, so any registered resource gets the same UX:
 * an action menu, an optional value form, a confirmation step for destructive
 * actions, inline execution for small batches, background polling for large
 * ones, CSV download for exports, and a partial-failure report.
 */

import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, ChevronDown, Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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

export type BulkActionOption = {
  kind: string
  label: string
  destructive?: boolean
  /** When set, the value is collected before submitting (e.g. a status). */
  value?: Record<string, unknown>
  /** Human confirmation copy shown for destructive actions. */
  confirmText?: string
}

type ReportRecord = {
  id: number
  outcome: "succeeded" | "failed" | "skipped"
  label: string | null
  reason: string | null
}

type BulkReport = {
  total: number
  succeeded: number
  failed: number
  skipped: number
  results: ReportRecord[]
}

type SubmitResponse =
  | { mode: "completed" | "replayed"; runId: number; status: string; report: BulkReport }
  | { mode: "queued"; runId: number; status: string; total: number }

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 5 * 60 * 1000

export function BulkActionBar({
  resourceKey,
  noun,
  selected,
  actions,
  onClear,
  onDone,
}: {
  resourceKey: string
  /** Singular noun, e.g. "company". Plural is `${noun}s`. */
  noun: string
  selected: number[]
  actions: BulkActionOption[]
  onClear: () => void
  onDone: () => void | Promise<unknown>
}) {
  const [pending, setPending] = useState<BulkActionOption | null>(null)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<BulkReport | null>(null)
  // A stable key per selection so a retried submit is idempotent server-side.
  const idempotencyRef = useRef<string>("")

  const count = selected.length
  const label = (n: number) => (n === 1 ? noun : `${noun}s`)

  const download = useCallback((filename: string, mime: string, content: string) => {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [])

  const pollUntilDone = useCallback(async (runId: number): Promise<BulkReport | null> => {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const res = await fetch(`/api/bulk/runs/${runId}`)
      if (!res.ok) continue
      const data = await res.json()
      if (data.status === "completed" || data.status === "failed") {
        return data.report as BulkReport | null
      }
    }
    return null
  }, [])

  const execute = useCallback(
    async (action: BulkActionOption) => {
      if (count === 0) return
      setRunning(true)
      if (!idempotencyRef.current) {
        idempotencyRef.current = `${resourceKey}:${action.kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`
      }
      try {
        const res = await fetch(`/api/bulk/${encodeURIComponent(resourceKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: action.kind,
            ids: selected,
            value: action.value,
            idempotencyKey: idempotencyRef.current,
          }),
        })

        // Export streams a file back rather than JSON.
        const contentType = res.headers.get("Content-Type") ?? ""
        if (res.ok && !contentType.includes("application/json")) {
          const text = await res.text()
          const disposition = res.headers.get("Content-Disposition") ?? ""
          const match = /filename="?([^"]+)"?/.exec(disposition)
          download(match?.[1] ?? `${resourceKey}-export.csv`, contentType || "text/csv", text)
          toast.success(`Exported ${count} ${label(count)}`)
          idempotencyRef.current = ""
          onClear()
          return
        }

        const data = (await res.json().catch(() => null)) as SubmitResponse | { error: string } | null
        if (!res.ok || !data) {
          toast.error((data as { error?: string })?.error ?? "Bulk action failed.")
          return
        }

        let finalReport: BulkReport | null = null
        if ("mode" in data && data.mode === "queued") {
          toast.info(`Processing ${data.total} ${label(data.total)} in the background…`)
          finalReport = await pollUntilDone(data.runId)
          if (!finalReport) {
            toast.warning("The bulk action is still running. Check back shortly.")
            return
          }
        } else if ("report" in data) {
          finalReport = data.report
        }

        idempotencyRef.current = ""
        if (finalReport) {
          summarize(finalReport, action.label, label)
          if (finalReport.failed > 0 || finalReport.skipped > 0) setReport(finalReport)
        }
        onClear()
        await onDone()
      } catch {
        toast.error("Something went wrong running the bulk action.")
      } finally {
        setRunning(false)
        setPending(null)
      }
    },
    [count, resourceKey, selected, download, pollUntilDone, onClear, onDone],
  )

  const onSelectAction = useCallback(
    (action: BulkActionOption) => {
      if (action.destructive) setPending(action)
      else void execute(action)
    },
    [execute],
  )

  if (count === 0) return null

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-4 py-2.5">
        <span className="text-sm font-medium">
          {count} {label(count)} selected
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClear} disabled={running}>
            <X data-icon="inline-start" />
            Clear
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="sm" disabled={running} />}
            >
              {running ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
              Bulk actions
              <ChevronDown data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actions.map((action) => (
                <DropdownMenuItem
                  key={`${action.kind}:${action.label}`}
                  variant={action.destructive ? "destructive" : undefined}
                  onClick={() => onSelectAction(action)}
                >
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !running && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
              >
                <AlertTriangle className="size-5" />
              </span>
              <div className="flex flex-col gap-1 text-left">
                <AlertDialogTitle>
                  {pending?.label} · {count} {label(count)}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pending?.confirmText ??
                    `This will ${pending?.label.toLowerCase()} ${count} selected ${label(count)}. Records you cannot act on are skipped.`}
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: "destructive" }))}
              disabled={running}
              onClick={(event) => {
                event.preventDefault()
                if (pending) void execute(pending)
              }}
            >
              {running ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
              {pending?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BulkReportDialog report={report} onClose={() => setReport(null)} />
    </>
  )
}

function summarize(report: BulkReport, actionLabel: string, label: (n: number) => string) {
  const { succeeded, failed, skipped } = report
  if (failed === 0 && skipped === 0) {
    toast.success(`${actionLabel}: ${succeeded} ${label(succeeded)} updated`)
  } else if (succeeded > 0) {
    toast.warning(`${actionLabel}: ${succeeded} updated, ${failed} failed, ${skipped} skipped`)
  } else {
    toast.error(`${actionLabel}: nothing changed (${failed} failed, ${skipped} skipped)`)
  }
}

function BulkReportDialog({ report, onClose }: { report: BulkReport | null; onClose: () => void }) {
  const problems = report?.results.filter((r) => r.outcome !== "succeeded") ?? []
  return (
    <AlertDialog open={report !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Bulk action report</AlertDialogTitle>
          <AlertDialogDescription>
            {report
              ? `${report.succeeded} succeeded · ${report.failed} failed · ${report.skipped} skipped of ${report.total} selected.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/60 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Record</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
                <th className="px-3 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-1.5">{r.label ?? `#${r.id}`}</td>
                  <td className="px-3 py-1.5 capitalize text-muted-foreground">{r.outcome}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{r.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>Close</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
