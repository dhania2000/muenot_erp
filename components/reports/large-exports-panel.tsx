"use client"

import useSWR from "swr"
import { Ban, Download, FileClock, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"

export const LARGE_EXPORTS_API = "/api/reports/exports"

type ExportJob = {
  id: number
  name: string
  format: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "expired"
  rowCount: number
  byteSize: number
  error: string | null
  cancelRequested: boolean
  createdAt: string
  expiresAt: string | null
  downloadPath: string | null
}

const STATUS_VARIANT: Record<ExportJob["status"], "default" | "secondary" | "destructive" | "outline"> = {
  queued: "secondary",
  running: "secondary",
  completed: "default",
  failed: "destructive",
  cancelled: "outline",
  expired: "outline",
}

function formatBytes(n: number): string {
  if (!n) return "—"
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function LargeExportsPanel() {
  const { data, isLoading, mutate } = useSWR<{ jobs: ExportJob[] }>(LARGE_EXPORTS_API, fetcher, {
    refreshInterval: (latest) =>
      latest?.jobs?.some((j) => j.status === "queued" || j.status === "running") ? 3000 : 0,
  })
  const jobs = data?.jobs ?? []

  async function cancel(id: number) {
    const res = await fetch(`${LARGE_EXPORTS_API}/${id}`, { method: "DELETE" })
    if (!res.ok) {
      const json = await res.json().catch(() => null)
      toast.error(json?.error || "Could not cancel the export.")
      return
    }
    toast.success("Cancellation requested.")
    mutate()
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileClock className="size-4" aria-hidden="true" /> Background exports
        </CardTitle>
        <CardDescription>
          Large exports (up to 1,000,000 CSV rows) are written to private storage. Download links are signed and expire.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading exports…
          </div>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No background exports yet. Use &quot;Queue large export&quot; in the builder to start one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Report</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="font-medium">
                      {j.name} <span className="text-xs uppercase text-muted-foreground">{j.format}</span>
                      {j.error && <p className="text-xs text-destructive">{j.error}</p>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[j.status]} className="capitalize">
                        {j.cancelRequested && j.status === "running" ? "cancelling" : j.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{j.rowCount.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(j.byteSize)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {j.expiresAt ? new Date(j.expiresAt).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {j.status === "completed" && j.downloadPath ? (
                        <Button asChild size="sm" variant="outline" className="gap-1.5">
                          <a href={j.downloadPath}>
                            <Download className="size-4" aria-hidden="true" /> Download
                          </a>
                        </Button>
                      ) : (j.status === "queued" || j.status === "running") && !j.cancelRequested ? (
                        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => cancel(j.id)}>
                          <Ban className="size-4" aria-hidden="true" /> Cancel
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
