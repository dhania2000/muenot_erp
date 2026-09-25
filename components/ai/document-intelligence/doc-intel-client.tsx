"use client"

import { useRef, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Upload, FileText, ScanLine, CheckCircle2, XCircle, ShieldAlert, Clock, Sparkles } from "lucide-react"

type ExtractedField = {
  key: string
  label: string
  value: string | null
  confidence: number
  source?: { line?: number; snippet?: string; start?: number; end?: number } | null
}

type Extraction = {
  id: number
  fileId: number
  fileRef: string
  docType: string
  status: string
  version: number
  language: string | null
  overallConfidence: number
  fields: ExtractedField[]
  warnings?: string[]
  error?: string | null
  reviewedBy?: number | null
  postedBy?: number | null
  dmsDocumentId?: number | null
}

type AuditEntry = {
  id: number
  action: string
  detail: string | null
  userId: number | null
  createdAt: string
  fromVersion?: number | null
  toVersion?: number | null
}

const DOC_TYPES = ["invoice", "receipt", "resume", "contract"] as const

const STATUS_META: Record<string, { label: string; className: string }> = {
  uploaded: { label: "Uploaded", className: "bg-muted text-muted-foreground" },
  queued: { label: "Queued", className: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" },
  processing: { label: "Processing", className: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" },
  extracted: { label: "Needs review", className: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  reviewed: { label: "Reviewed", className: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300" },
  posted: { label: "Posted", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
}

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, className: "bg-muted text-muted-foreground" }
  return <Badge className={meta.className}>{meta.label}</Badge>
}

function confidenceTone(v: number): string {
  if (v >= 0.8) return "text-emerald-600 dark:text-emerald-400"
  if (v >= 0.5) return "text-amber-600 dark:text-amber-400"
  return "text-red-600 dark:text-red-400"
}

export function DocIntelClient() {
  const { data, isLoading, mutate } = useSWR<{ extractions: Extraction[] }>(
    "/api/ai/document-intelligence/extractions",
    fetcher,
  )
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [uploadType, setUploadType] = useState<string>("auto")
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const extractions = data?.extractions ?? []

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!file) {
      toast.error("Choose a file to upload")
      return
    }
    setUploading(true)
    try {
      const form = new FormData()
      form.append("file", file)
      if (uploadType !== "auto") form.append("docType", uploadType)
      const res = await fetch("/api/ai/document-intelligence/upload", { method: "POST", body: form })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Upload failed")
      toast.success(body.deduped ? "Document already ingested — showing existing job" : "Document ingested")
      if (fileRef.current) fileRef.current.value = ""
      await mutate()
      setSelectedId(body.extraction.id)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" aria-hidden />
          <h1 className="text-2xl font-semibold tracking-tight">AI Document Intelligence</h1>
        </div>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Extract invoice, receipt, resume and contract fields from scanned documents. Every extraction shows source
          highlights and confidence, and requires human review before a record is posted.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="size-4" aria-hidden /> Ingest a document
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleUpload} className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="doc-file">Document file</Label>
              <Input id="doc-file" ref={fileRef} type="file" accept=".txt,.csv,.json,.xml,.md,.eml,.pdf,image/*" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-type">Type</Label>
              <Select value={uploadType} onValueChange={setUploadType}>
                <SelectTrigger id="doc-type" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-detect</SelectItem>
                  {DOC_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={uploading}>
              {uploading ? "Uploading…" : "Upload & queue"}
            </Button>
          </form>
          <p className="text-muted-foreground mt-2 text-xs">
            Uploads are malware-scanned first. Extraction only runs after a clean verdict and tenant authorization.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Extractions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <p className="text-muted-foreground p-4 text-sm">Loading…</p>
            ) : extractions.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-8 text-center">
                <FileText className="text-muted-foreground size-8" aria-hidden />
                <p className="text-muted-foreground text-sm">No documents ingested yet.</p>
              </div>
            ) : (
              <ul className="divide-border divide-y">
                {extractions.map((x) => (
                  <li key={x.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(x.id)}
                      className={`hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                        selectedId === x.id ? "bg-muted" : ""
                      }`}
                    >
                      <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{x.fileRef}</p>
                        <p className="text-muted-foreground text-xs capitalize">
                          {x.docType} · v{x.version}
                        </p>
                      </div>
                      <StatusBadge status={x.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <ExtractionDetail
          key={selectedId ?? "none"}
          extractionId={selectedId}
          onChanged={() => mutate()}
        />
      </div>
    </div>
  )
}

function ExtractionDetail({ extractionId, onChanged }: { extractionId: number | null; onChanged: () => void }) {
  const { data, isLoading, mutate } = useSWR<{ extraction: Extraction; versions: any[]; audit: AuditEntry[] }>(
    extractionId ? `/api/ai/document-intelligence/extractions/${extractionId}` : null,
    fetcher,
  )
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  if (!extractionId) {
    return (
      <Card className="flex items-center justify-center">
        <CardContent className="text-muted-foreground py-16 text-center text-sm">
          Select a document to review its extracted fields.
        </CardContent>
      </Card>
    )
  }

  if (isLoading || !data) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-16 text-center text-sm">Loading…</CardContent>
      </Card>
    )
  }

  const x = data.extraction

  async function call(path: string, payload?: unknown, label = "Done") {
    setBusy(path)
    try {
      const res = await fetch(`/api/ai/document-intelligence/extractions/${x.id}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Request failed")
      toast.success(label)
      setEdits({})
      await mutate()
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function submitReview(decision: "approve" | "reject") {
    const corrections = Object.entries(edits).map(([key, value]) => ({ key, value }))
    void call("review", { decision, corrections }, decision === "approve" ? "Review saved" : "Extraction rejected")
  }

  const canReview = x.status === "extracted" || x.status === "reviewed"
  const canPost = x.status === "reviewed"
  const canProcess = ["uploaded", "queued", "extracted", "failed"].includes(x.status)

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base capitalize">
            {x.docType} — {x.fileRef}
          </CardTitle>
          <StatusBadge status={x.status} />
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <span className="text-muted-foreground">Version {x.version}</span>
          {x.language && <span className="text-muted-foreground uppercase">{x.language}</span>}
          <span className={`font-medium ${confidenceTone(x.overallConfidence)}`}>
            {Math.round(x.overallConfidence * 100)}% confidence
          </span>
        </div>
        {x.warnings && x.warnings.length > 0 && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{x.warnings.join(" · ")}</span>
          </div>
        )}
        {x.error && <p className="text-xs text-red-600 dark:text-red-400">{x.error}</p>}
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {canProcess && (
            <Button size="sm" variant="secondary" disabled={busy != null} onClick={() => call("process", {}, "Extraction complete")}>
              <ScanLine className="size-4" aria-hidden /> {x.status === "failed" ? "Retry extraction" : "Run extraction"}
            </Button>
          )}
          {canPost && (
            <Button size="sm" disabled={busy != null} onClick={() => call("post", {}, "Record posted")}>
              <CheckCircle2 className="size-4" aria-hidden /> Post record
            </Button>
          )}
          {x.status === "posted" && x.dmsDocumentId && (
            <Badge variant="outline" className="gap-1">
              <CheckCircle2 className="size-3.5" aria-hidden /> Posted as DMS #{x.dmsDocumentId}
            </Badge>
          )}
        </div>

        {x.fields.length > 0 && (
          <>
            <Separator />
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Extracted fields</h3>
              {x.fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={`f-${f.key}`} className="text-xs">
                      {f.label}
                    </Label>
                    <span className={`text-xs font-medium ${confidenceTone(f.confidence)}`}>
                      {Math.round(f.confidence * 100)}%
                    </span>
                  </div>
                  <Progress value={f.confidence * 100} className="h-1" />
                  <Input
                    id={`f-${f.key}`}
                    disabled={!canReview || busy != null}
                    defaultValue={f.value ?? ""}
                    onChange={(e) => setEdits((p) => ({ ...p, [f.key]: e.target.value }))}
                  />
                  {f.source?.snippet && (
                    <p className="text-muted-foreground bg-muted/50 rounded px-2 py-1 text-xs">
                      <span className="font-medium">Source{f.source.line != null ? ` (line ${f.source.line})` : ""}:</span>{" "}
                      <mark className="bg-amber-200/60 dark:bg-amber-500/30">{f.source.snippet}</mark>
                    </p>
                  )}
                </div>
              ))}
            </div>

            {canReview && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy != null} onClick={() => submitReview("approve")}>
                  Approve review
                </Button>
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => submitReview("reject")}>
                  <XCircle className="size-4" aria-hidden /> Reject
                </Button>
              </div>
            )}
          </>
        )}

        <Separator />
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Clock className="size-3.5" aria-hidden /> Audit trail
          </h3>
          <ScrollArea className="h-40 rounded-md border">
            <ul className="divide-border divide-y text-xs">
              {data.audit.length === 0 && <li className="text-muted-foreground p-3">No audit entries.</li>}
              {data.audit.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 p-2">
                  <span className="font-medium capitalize">{a.action.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground truncate">{a.detail}</span>
                  <span className="text-muted-foreground shrink-0">{new Date(a.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      </CardContent>
    </Card>
  )
}
