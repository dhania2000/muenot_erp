"use client"

import { useState } from "react"
import useSWR from "swr"
import { Loader2, RotateCcw, ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/security/security-ui"

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed")
  return res.json()
}

type ScanRow = {
  id: number
  fileId: number
  fileRef: string | null
  filename: string | null
  module: string | null
  scanStatus: string
  safety: string
  quarantineStatus: string
  provider: string | null
  scannedAt: string | null
  detail: string | null
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z")
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: "Pending", className: "" },
  scanning: { label: "Scanning", className: "border-transparent bg-blue-600 text-white" },
  clean: { label: "Safe", className: "border-transparent bg-emerald-600 text-white" },
  infected: { label: "Unsafe", className: "border-transparent bg-destructive text-white" },
  error: { label: "Failed", className: "border-transparent bg-amber-600 text-white" },
}

/**
 * File security / malware-scan dashboard. Reads the real,
 * already-implemented scan ledger; rescan / release call the same backend
 * actions the file detail drawer uses.
 */
export function StorageSecurityDashboard() {
  const { data, isLoading, error, mutate } = useSWR<{ scans: ScanRow[]; summary: Record<string, number> }>(
    "/api/admin/storage/security",
    fetcher,
    { revalidateOnFocus: false },
  )
  const scans = data?.scans ?? []
  const summary = data?.summary ?? { totalFiles: 0, safe: 0, pending: 0, quarantined: 0, failed: 0 }

  const [busyId, setBusyId] = useState<number | null>(null)

  async function runAction(fileId: number, action: "rescan" | "release") {
    setBusyId(fileId)
    try {
      await fetch(`/api/admin/storage/security/${fileId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      await mutate()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCard label="Total files" value={summary.totalFiles} icon={<ShieldQuestion className="size-4" />} />
        <SummaryCard label="Safe" value={summary.safe} icon={<ShieldCheck className="size-4" />} tone="emerald" />
        <SummaryCard label="Pending" value={summary.pending} icon={<ShieldQuestion className="size-4" />} tone="amber" />
        <SummaryCard label="Quarantined" value={summary.quarantined} icon={<ShieldOff className="size-4" />} tone="red" />
        <SummaryCard label="Failed scans" value={summary.failed} icon={<ShieldAlert className="size-4" />} tone="red" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scan ledger</CardTitle>
          <CardDescription>Every file&apos;s security scan result, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {error && <p className="text-sm text-destructive">Could not load scan records.</p>}
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : scans.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="size-5" />} title="No scans recorded yet">
              Files are scanned automatically as they are uploaded across every module.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Module</TableHead>
                    <TableHead>Scan status</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Last scan</TableHead>
                    <TableHead>Quarantine</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scans.map((s) => {
                    const badge = STATUS_BADGE[s.scanStatus] ?? { label: s.scanStatus, className: "" }
                    return (
                      <TableRow key={s.id}>
                        <TableCell className="max-w-[200px] truncate font-medium">
                          {s.filename || s.fileRef}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{s.module || "—"}</TableCell>
                        <TableCell>
                          <Badge className={badge.className} variant={badge.className ? undefined : "outline"}>
                            {badge.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{s.provider || "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(s.scannedAt)}</TableCell>
                        <TableCell className="text-muted-foreground">{s.quarantineStatus}</TableCell>
                        <TableCell className="max-w-[160px] truncate text-xs text-destructive">
                          {s.detail || "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyId === s.fileId}
                              onClick={() => runAction(s.fileId, "rescan")}
                            >
                              {busyId === s.fileId ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="size-3.5" />
                              )}
                              Rescan
                            </Button>
                            {s.quarantineStatus === "quarantined" && s.scanStatus !== "infected" && (
                              <Button size="sm" disabled={busyId === s.fileId} onClick={() => runAction(s.fileId, "release")}>
                                Release
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string
  value: number
  icon: React.ReactNode
  tone?: "emerald" | "amber" | "red"
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "red"
          ? "text-destructive"
          : "text-foreground"
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className={`text-2xl ${toneClass}`}>{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}
