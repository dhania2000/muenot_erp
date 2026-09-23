"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2, RotateCcw, ShieldCheck } from "lucide-react"
import { formatBytes } from "@/lib/storage/format"
import type { StorageFile } from "@/lib/storage/client-types"

export type BrowserFile = StorageFile & {
  ownerName: string | null
  scanStatus: string
  safety: string
  quarantineStatus: string
}

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed")
  return res.json()
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z")
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium break-all">{value ?? "—"}</span>
    </div>
  )
}

/**
 * File Detail drawer. Overview / Versions / Security / Retention /
 * Activity tabs over the real, already-implemented centralized file metadata,
 * versioning, and security-scan models.
 */
export function FileDetailDrawer({
  file,
  onClose,
  onChanged,
}: {
  file: BrowserFile | null
  onClose: () => void
  onChanged: () => void
}) {
  const [tab, setTab] = useState("overview")
  useEffect(() => {
    if (file) setTab("overview")
  }, [file?.id])

  const { data: versions, isLoading: versionsLoading } = useSWR<{
    versions: (StorageFile & { uploadedByName: string | null })[]
    audit: { id: number; version: number; action: string; detail: string | null; userName: string | null; createdAt: string | null }[]
  }>(file ? `/api/storage/versions/${file.id}` : null, fetcher, { revalidateOnFocus: false })

  const {
    data: security,
    isLoading: securityLoading,
    mutate: mutateSecurity,
  } = useSWR<{ scan: any }>(file ? `/api/admin/storage/security/${file.id}` : null, fetcher, {
    revalidateOnFocus: false,
  })

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")

  async function runAction(action: "rescan" | "release") {
    if (!file) return
    setBusy(true)
    setNotice("")
    try {
      const res = await fetch(`/api/admin/storage/security/${file.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Action failed")
      setNotice(action === "rescan" ? "Rescan complete." : "File released for download.")
      await mutateSecurity()
      onChanged()
    } catch (err: any) {
      setNotice(err.message || "Action failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={!!file} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="break-all">{file?.filename || file?.fileRef}</SheetTitle>
          <SheetDescription>
            {file?.fileRef} · {file?.module}
          </SheetDescription>
        </SheetHeader>

        {file && (
          <div className="px-4 pb-6">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="versions">Versions</TabsTrigger>
                <TabsTrigger value="security">Security</TabsTrigger>
                <TabsTrigger value="retention">Retention</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="mt-4 grid grid-cols-2 gap-4">
                <Field label="File ID" value={file.fileRef} />
                <Field label="Owner" value={file.ownerName} />
                <Field label="Module" value={file.module} />
                <Field label="Related entity" value={file.entityType} />
                <Field label="Record ID" value={file.entityId} />
                <Field label="Object key" value={<span className="font-mono text-xs">{file.objectKey}</span>} />
                <Field label="Provider" value={file.provider} />
                <Field label="MIME type" value={file.mimeType} />
                <Field label="Size" value={formatBytes(file.size)} />
                <Field label="Checksum (SHA-256)" value={<span className="font-mono text-xs">{file.checksum}</span>} />
                <Field
                  label="Upload status"
                  value={<Badge variant="outline">{file.uploadStatus}</Badge>}
                />
                <Field label="Version" value={`v${file.version}${file.isCurrent ? " (current)" : ""}`} />
                <Field label="Classification" value={file.classification} />
                <Field label="Retention" value={file.retentionPolicy} />
                <Field label="Created" value={formatDate(file.createdAt)} />
                <Field label="Modified" value={formatDate(file.updatedAt)} />
                <Field label="Uploaded by" value={file.ownerName} />
              </TabsContent>

              <TabsContent value="versions" className="mt-4 flex flex-col gap-2">
                {versionsLoading && <p className="text-sm text-muted-foreground">Loading versions…</p>}
                {versions?.versions?.map((v) => (
                  <div key={v.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">v{v.version}</span>
                      {v.isCurrent && (
                        <Badge className="gap-1">
                          <ShieldCheck className="size-3" /> Current
                        </Badge>
                      )}
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <div>{v.uploadedByName || "—"}</div>
                      <div>{formatDate(v.createdAt)}</div>
                    </div>
                  </div>
                ))}
                {versions && versions.versions.length === 0 && (
                  <p className="text-sm text-muted-foreground">No version history for this file.</p>
                )}
              </TabsContent>

              <TabsContent value="security" className="mt-4 flex flex-col gap-4">
                {securityLoading && <p className="text-sm text-muted-foreground">Loading security state…</p>}
                {security?.scan ? (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <Field label="Scan status" value={<Badge variant="outline">{security.scan.scanStatus}</Badge>} />
                      <Field label="Safety" value={security.scan.safety} />
                      <Field label="Quarantine" value={security.scan.quarantineStatus} />
                      <Field label="Provider" value={security.scan.provider} />
                      <Field label="Last scanned" value={formatDate(security.scan.scannedAt)} />
                      <Field label="Attempts" value={security.scan.attempts} />
                    </div>
                    {security.scan.findings?.length > 0 && (
                      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                        <p className="font-medium text-destructive">Findings</p>
                        <ul className="mt-1 list-inside list-disc">
                          {security.scan.findings.map((f: any, i: number) => (
                            <li key={i}>
                              {f.signature} ({f.severity})
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => runAction("rescan")}>
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                        Rescan
                      </Button>
                      {security.scan.quarantineStatus === "quarantined" && security.scan.scanStatus !== "infected" && (
                        <Button size="sm" disabled={busy} onClick={() => runAction("release")}>
                          Release
                        </Button>
                      )}
                    </div>
                    {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
                  </>
                ) : (
                  !securityLoading && <p className="text-sm text-muted-foreground">No scan has been recorded yet.</p>
                )}
              </TabsContent>

              <TabsContent value="retention" className="mt-4 grid grid-cols-2 gap-4">
                <Field label="Retention policy" value={file.retentionPolicy} />
                <Field label="Expires" value={formatDate(file.retentionExpiresAt)} />
                <Field label="Legal hold" value={file.legalHold ? "Yes — deletion blocked" : "No"} />
                <Field label="Classification" value={file.classification} />
              </TabsContent>

              <TabsContent value="activity" className="mt-4 flex flex-col gap-2">
                {versions?.audit?.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                    <Badge variant="outline">{a.action}</Badge>
                    <span className="font-medium">v{a.version}</span>
                    <span className="text-muted-foreground">{a.detail || ""}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {a.userName ? `${a.userName} · ` : ""}
                      {formatDate(a.createdAt)}
                    </span>
                  </div>
                ))}
                {versions && versions.audit.length === 0 && (
                  <p className="text-sm text-muted-foreground">No activity recorded for this file yet.</p>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
