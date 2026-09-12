"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { LetterStatusBadge } from "@/components/hr/letter-status-badge"
import {
  Eye,
  Download,
  Mail,
  RefreshCcw,
  Ban,
  Trash2,
  Loader2,
  History,
  ArrowRight,
} from "lucide-react"
import { LETTER_STATUSES, eventByKey, type GeneratedLetter, type LetterStatus } from "@/lib/hr-letters-shared"

type Version = {
  id: number
  letter_number: string
  status: string
  template_version: number | null
  created_at: string | null
  supersedes_id: number | null
  superseded_by: number | null
}

type LetterAuditEvent = {
  id: number
  event_type: string
  summary: string
  actor_name: string | null
  created_at: string | null
}

type DetailResponse = {
  letter: GeneratedLetter & {
    template_name?: string | null
    created_by_name?: string | null
    issued_at?: string | null
    delivered_at?: string | null
    event_key?: string
    recipient_name?: string | null
    reference_no?: string | null
    cancel_reason?: string | null
    cancelled_at?: string | null
  }
  versions: Version[]
  events?: LetterAuditEvent[]
}

const EVENT_DOT: Record<string, string> = {
  generated: "bg-emerald-500",
  regenerated: "bg-sky-500",
  status_changed: "bg-amber-500",
  issued: "bg-blue-500",
  delivered: "bg-emerald-500",
  emailed: "bg-violet-500",
  cancelled: "bg-red-500",
  deleted: "bg-red-500",
  filed_to_documents: "bg-teal-500",
  pdf_downloaded: "bg-slate-400",
}

function fmt(value?: string | null) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  )
}

export function LetterDetailDialog({
  letterId,
  onClose,
  onChanged,
  onSelectLetter,
}: {
  letterId: number | null
  onClose: () => void
  onChanged?: () => void
  onSelectLetter?: (id: number) => void
}) {
  const { data, isLoading, mutate } = useSWR<DetailResponse>(
    letterId ? `/api/hr/letters/${letterId}` : null,
    fetcher,
  )
  const letter = data?.letter
  const versions = data?.versions || []
  const events = data?.events || []

  const [busy, setBusy] = useState<string | null>(null)
  const [emailOpen, setEmailOpen] = useState(false)
  const [emailTo, setEmailTo] = useState("")
  const [emailMessage, setEmailMessage] = useState("")
  const [statusTo, setStatusTo] = useState<string>("")
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState("")

  const active = !!letterId
  const cancelled = letter?.status === "Cancelled"
  const isDraft = letter?.status === "Draft"

  function refresh() {
    mutate()
    onChanged?.()
  }

  async function changeStatus() {
    if (!letter || !statusTo || statusTo === letter.status) return
    setBusy("status")
    try {
      const res = await fetch(`/api/hr/letters/${letter.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: statusTo }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to update status")
      toast.success(`Marked as ${statusTo}`)
      setStatusTo("")
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function regenerate() {
    if (!letter) return
    if (!confirm("Regenerate this letter from the current template and source data? The current version will be cancelled.")) return
    setBusy("regen")
    try {
      const res = await fetch(`/api/hr/letters/${letter.id}/regenerate`, { method: "POST" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Failed to regenerate")
      toast.success("New version generated")
      onChanged?.()
      if (body.letter?.id && onSelectLetter) onSelectLetter(body.letter.id)
      else refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function sendEmail() {
    if (!letter) return
    setBusy("email")
    try {
      const res = await fetch(`/api/hr/letters/${letter.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: emailTo || undefined, message: emailMessage || undefined }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Failed to send email")
      toast.success(`Emailed to ${body.to}`)
      setEmailOpen(false)
      setEmailTo("")
      setEmailMessage("")
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function deleteDraft() {
    if (!letter) return
    if (!confirm("Delete this draft letter permanently?")) return
    setBusy("cancel")
    try {
      const res = await fetch(`/api/hr/letters/${letter.id}`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Failed")
      toast.success("Draft deleted")
      onChanged?.()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function submitCancel() {
    if (!letter) return
    const reason = cancelReason.trim()
    if (!reason) {
      toast.error("A cancellation reason is required")
      return
    }
    setBusy("cancel")
    try {
      const res = await fetch(`/api/hr/letters/${letter.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Failed to cancel")
      toast.success("Letter cancelled")
      setCancelOpen(false)
      setCancelReason("")
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  const pdfUrl = letter ? `/api/hr/letters/${letter.id}/pdf` : "#"

  return (
    <Dialog open={active} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-hidden p-0 sm:max-w-4xl">
        {isLoading || !letter ? (
          <div className="flex h-64 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="grid max-h-[90vh] grid-rows-[auto_minmax(0,1fr)]">
            <DialogHeader className="border-b px-6 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <DialogTitle className="text-base">{letter.subject}</DialogTitle>
                <LetterStatusBadge status={letter.status} />
              </div>
              <DialogDescription className="font-mono text-xs">
                {letter.reference_no || letter.letter_number}
                <span className="text-muted-foreground/70"> · {letter.letter_number}</span>
                {letter.template_version ? ` · v${letter.template_version}` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-0 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_320px]">
              {/* Paper preview */}
              <div className="bg-muted/30 p-6">
                <article className="mx-auto max-w-[640px] rounded-md bg-background p-8 shadow-sm ring-1 ring-border">
                  <header className="mb-6 border-b pb-4">
                    <div className="text-sm font-semibold text-foreground">
                      {letter.recipient_name || letter.employee_name || "Recipient"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[letter.employee_code, [letter.designation, letter.department].filter(Boolean).join(", ")]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">Date: {letter.issue_date}</div>
                  </header>
                  <h2 className="mb-4 font-serif text-lg font-semibold text-foreground text-pretty">{letter.subject}</h2>
                  <div className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-foreground">
                    {letter.body}
                  </div>
                </article>
              </div>

              {/* Sidebar: metadata + actions */}
              <aside className="flex flex-col gap-5 border-t p-6 lg:border-l lg:border-t-0">
                {cancelled && letter.cancel_reason && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <Ban className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <div className="grid gap-0.5">
                      <span className="font-medium text-destructive">Cancelled</span>
                      <span className="text-foreground">{letter.cancel_reason}</span>
                      {letter.cancelled_at && (
                        <span className="text-xs text-muted-foreground">{fmt(letter.cancelled_at)}</span>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => window.open(pdfUrl, "_blank")}>
                    <Eye data-icon="inline-start" /> View PDF
                  </Button>
                  <a
                    href={`${pdfUrl}?download=1`}
                    className={buttonVariants({ size: "sm", variant: "outline" })}
                  >
                    <Download data-icon="inline-start" /> Download
                  </a>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={cancelled}
                    onClick={() => {
                      setEmailOpen((v) => !v)
                    }}
                  >
                    <Mail data-icon="inline-start" /> Email
                  </Button>
                </div>

                {emailOpen && (
                  <div className="grid gap-3 rounded-lg border bg-card p-4">
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Recipient (optional)</Label>
                      <Input
                        type="email"
                        value={emailTo}
                        onChange={(e) => setEmailTo(e.target.value)}
                        placeholder="Leave blank to use employee email"
                        className="h-8"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Message (optional)</Label>
                      <Textarea
                        value={emailMessage}
                        onChange={(e) => setEmailMessage(e.target.value)}
                        rows={3}
                        placeholder="Custom cover note…"
                      />
                    </div>
                    <Button size="sm" onClick={sendEmail} disabled={busy === "email"}>
                      {busy === "email" ? <Loader2 className="size-4 animate-spin" /> : <Mail data-icon="inline-start" />}
                      Send PDF
                    </Button>
                  </div>
                )}

                <dl className="grid grid-cols-2 gap-4">
                  <Meta label="Reference no">
                    <span className="font-mono text-xs">{letter.reference_no || "—"}</span>
                  </Meta>
                  <Meta label="Letter ID">
                    <span className="font-mono text-xs">{letter.letter_number}</span>
                  </Meta>
                  <Meta label="Type">{letter.letter_type}</Meta>
                  <Meta label="Category">{letter.category || "General"}</Meta>
                  <Meta label="Event">{eventByKey(letter.event_key).label}</Meta>
                  <Meta label="Source">{letter.source}{letter.source_ref ? ` · ${letter.source_ref}` : ""}</Meta>
                  <Meta label="Template">{letter.template_name || (letter.template_id ? `#${letter.template_id}` : "Ad-hoc")}</Meta>
                  <Meta label="Audience">{letter.audience || "Employee"}</Meta>
                  <Meta label="Created">{fmt(letter.created_at)}</Meta>
                  <Meta label="Created by">{letter.created_by_name || "—"}</Meta>
                  <Meta label="Issued">{fmt(letter.issued_at)}</Meta>
                  <Meta label="Delivered">{fmt(letter.delivered_at)}</Meta>
                </dl>

                {/* Status transition */}
                {!cancelled && (
                  <div className="grid gap-2 rounded-lg border bg-card p-4">
                    <Label className="text-xs uppercase tracking-wide text-muted-foreground">Change status</Label>
                    <div className="flex gap-2">
                      <Select value={statusTo} onValueChange={(v) => setStatusTo(v ?? "")}>
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                        <SelectContent>
                          {LETTER_STATUSES.filter((s) => s !== "Cancelled" && s !== letter.status).map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button size="sm" onClick={changeStatus} disabled={!statusTo || busy === "status"}>
                        {busy === "status" ? <Loader2 className="size-4 animate-spin" /> : "Apply"}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Version lineage */}
                {versions.length > 1 && (
                  <div className="grid gap-2">
                    <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                      <History className="size-3.5" /> Version history
                    </div>
                    <ul className="grid gap-1.5">
                      {versions.map((v) => (
                        <li key={v.id}>
                          <button
                            type="button"
                            onClick={() => v.id !== letter.id && onSelectLetter?.(v.id)}
                            className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                              v.id === letter.id ? "border-primary bg-primary/5" : "hover:bg-accent"
                            }`}
                          >
                            <span className="font-mono">{v.letter_number}</span>
                            <span className="flex items-center gap-2 text-muted-foreground">
                              {v.status}
                              {v.id !== letter.id && <ArrowRight className="size-3" />}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Audit history */}
                {events.length > 0 && (
                  <div className="grid gap-2">
                    <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                      <History className="size-3.5" /> Audit history
                    </div>
                    <ul className="grid gap-3 border-l pl-4">
                      {events.map((e) => (
                        <li key={e.id} className="relative">
                          <span
                            className={`absolute -left-[21px] top-1 size-2.5 rounded-full ring-2 ring-background ${
                              EVENT_DOT[e.event_type] || "bg-slate-400"
                            }`}
                          />
                          <div className="text-sm text-foreground text-pretty">{e.summary}</div>
                          <div className="text-xs text-muted-foreground">
                            {[e.actor_name, fmt(e.created_at)].filter(Boolean).join(" · ")}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Cancel panel (reason required) */}
                {cancelOpen && !cancelled && !isDraft && (
                  <div className="grid gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                    <div className="grid gap-1.5">
                      <Label className="text-xs">Cancellation reason</Label>
                      <Textarea
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                        rows={3}
                        placeholder="Why is this letter being cancelled? (recorded in the audit trail)"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={submitCancel}
                        disabled={busy === "cancel" || !cancelReason.trim()}
                      >
                        {busy === "cancel" ? <Loader2 className="size-4 animate-spin" /> : <Ban data-icon="inline-start" />}
                        Confirm cancel
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setCancelOpen(false)} disabled={busy === "cancel"}>
                        Keep letter
                      </Button>
                    </div>
                  </div>
                )}

                {/* Danger zone */}
                <div className="mt-auto flex flex-wrap gap-2 border-t pt-4">
                  <Button size="sm" variant="outline" onClick={regenerate} disabled={busy === "regen" || cancelled}>
                    {busy === "regen" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw data-icon="inline-start" />}
                    Regenerate
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={isDraft ? deleteDraft : () => setCancelOpen((v) => !v)}
                    disabled={busy === "cancel" || cancelled}
                  >
                    {busy === "cancel" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : isDraft ? (
                      <Trash2 data-icon="inline-start" />
                    ) : (
                      <Ban data-icon="inline-start" />
                    )}
                    {isDraft ? "Delete" : "Cancel"}
                  </Button>
                </div>
              </aside>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
