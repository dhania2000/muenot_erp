"use client"

import { useState } from "react"
import useSWR from "swr"
import { History, RotateCcw, Download, FileClock, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type FileRow = {
  id: number
  fileRef: string
  filename: string | null
  module: string
  version: number
  mimeType: string | null
  size: number
}

type Version = {
  id: number
  fileRef: string
  filename: string | null
  version: number
  isCurrent: boolean
  size: number
  uploadStatus: string
  uploadedByName: string | null
  ownerId: number | null
  createdAt: string | null
}

type AuditEntry = {
  id: number
  version: number
  action: string
  detail: string | null
  userName: string | null
  createdAt: string | null
}

type History = {
  current: Version | null
  versions: Version[]
  audit: AuditEntry[]
}

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed")
  return res.json()
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z")
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

const ACTION_LABELS: Record<string, string> = {
  uploaded: "Uploaded",
  restored: "Restored",
  downloaded: "Downloaded",
  deleted: "Deleted",
}

/**
 * Document versioning UI. Pick a versioned file, review its full
 * version history (number, uploader, timestamp, current flag), restore any
 * historical version, download a specific version, and read the audit trail.
 */
export function FileVersionsPanel() {
  const { data: filesData } = useSWR<{ files: FileRow[] }>("/api/storage/files", fetcher, {
    revalidateOnFocus: false,
  })
  const files = filesData?.files ?? []

  const [selectedId, setSelectedId] = useState<string>("")
  const {
    data: history,
    mutate: mutateHistory,
    isLoading,
  } = useSWR<History>(selectedId ? `/api/storage/versions/${selectedId}` : null, fetcher, {
    revalidateOnFocus: false,
  })

  const [busyId, setBusyId] = useState<number | null>(null)
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  async function handleRestore(version: Version) {
    setBusyId(version.id)
    setMessage(null)
    try {
      const res = await fetch(`/api/storage/versions/${version.id}/restore`, { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Restore failed")
      setMessage({ kind: "ok", text: `Restored v${version.version} as v${body.version?.version ?? "?"}.` })
      // The new current version keeps the same chain, re-fetch against it.
      if (body.version?.id) setSelectedId(String(body.version.id))
      await mutateHistory()
    } catch (err: any) {
      setMessage({ kind: "error", text: err.message || "Restore failed" })
    } finally {
      setBusyId(null)
    }
  }

  async function handleDownload(version: Version) {
    setBusyId(version.id)
    setMessage(null)
    try {
      const res = await fetch(`/api/storage/versions/${version.id}/download`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Download failed")
      // Works whether framed or standalone.
      window.open(body.url, "_blank", "noopener,noreferrer")
      await mutateHistory()
    } catch (err: any) {
      setMessage({ kind: "error", text: err.message || "Download failed" })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileClock className="size-5 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Document versions</CardTitle>
        </div>
        <CardDescription>
          Review every version of a document, see who uploaded each one and when, restore a previous version, or
          download a historical copy. Restoring never overwrites — it creates a new current version.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="file-picker" className="text-sm font-medium">
            File
          </label>
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger id="file-picker" className="max-w-md">
              <SelectValue placeholder={files.length ? "Select a document…" : "No versioned documents yet"} />
            </SelectTrigger>
            <SelectContent>
              {files.map((f) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.filename || f.fileRef} · {f.module} · v{f.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {message && (
          <p
            role="status"
            className={
              message.kind === "ok"
                ? "text-sm text-emerald-600 dark:text-emerald-400"
                : "text-sm text-destructive"
            }
          >
            {message.text}
          </p>
        )}

        {selectedId && isLoading && <p className="text-sm text-muted-foreground">Loading version history…</p>}

        {history && !isLoading && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <History className="size-4 text-muted-foreground" aria-hidden="true" />
                <h3 className="text-sm font-medium">Version history</h3>
              </div>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Version</TableHead>
                      <TableHead>Uploaded by</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.versions.map((v) => (
                      <TableRow key={v.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            v{v.version}
                            {v.isCurrent && (
                              <Badge variant="default" className="gap-1">
                                <ShieldCheck className="size-3" aria-hidden="true" />
                                Current
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{v.uploadedByName || "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(v.createdAt)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatBytes(v.size)}</TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busyId === v.id || v.uploadStatus === "deleted"}
                              onClick={() => handleDownload(v)}
                            >
                              <Download className="size-3.5" aria-hidden="true" />
                              <span className="sr-only sm:not-sr-only sm:ml-1">Download</span>
                            </Button>
                            {!v.isCurrent && (
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={busyId === v.id || v.uploadStatus === "deleted"}
                                onClick={() => handleRestore(v)}
                              >
                                <RotateCcw className="size-3.5" aria-hidden="true" />
                                <span className="sr-only sm:not-sr-only sm:ml-1">Restore</span>
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {history.versions.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                          No versions found.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Audit history</h3>
              {history.audit.length === 0 ? (
                <p className="text-sm text-muted-foreground">No version actions recorded yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {history.audit.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                      <Badge variant="outline">{ACTION_LABELS[a.action] ?? a.action}</Badge>
                      <span className="font-medium">v{a.version}</span>
                      <span className="text-muted-foreground">{a.detail || ""}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {a.userName ? `${a.userName} · ` : ""}
                        {formatDate(a.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
