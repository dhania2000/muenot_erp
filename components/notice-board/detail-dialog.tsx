"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Loader2, Check, Download, FileText, History } from "lucide-react"
import {
  type AudienceConfig, type AudienceType, type Priority, type Status,
  PriorityBadge, StatusBadge, audienceSummary, formatDate, formatDateTime,
} from "./shared"

type DetailNotice = {
  id: number
  notice_code: string | null
  heading: string
  description: string
  category: string
  priority: Priority
  status: Status
  to_type: "employees" | "clients"
  audience_type: AudienceType
  audience_config: AudienceConfig
  acknowledgement_required: boolean
  pinned: boolean
  start_date: string | null
  end_date: string | null
  publish_date: string | null
  published_at: string | null
  effective_date: string | null
  review_date: string | null
  cancel_reason: string | null
  version: number
  created_by_name: string | null
  created_at: string
  updated_by_name: string | null
  attachments: { id: number; file_name: string; file_type: string | null; file_size: number }[]
  is_read?: boolean
  is_acknowledged?: boolean
  audit?: { action: string; detail: string | null; user_name: string | null; created_at: string }[]
  versions?: { version: number; heading: string; edited_by_name: string | null; edited_at: string }[]
}

export function DetailDialog({
  noticeId, open, onOpenChange, onChanged,
}: {
  noticeId: number | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onChanged?: () => void
}) {
  const { data, isLoading, mutate } = useSWR<{ notice: DetailNotice; canManage: boolean }>(
    open && noticeId != null ? `/api/notice-board/${noticeId}` : null,
    fetcher,
  )
  const [acking, setAcking] = useState(false)

  const n = data?.notice
  const canManage = data?.canManage

  async function acknowledge() {
    if (!n) return
    setAcking(true)
    try {
      const res = await fetch(`/api/notice-board/${n.id}/acknowledge`, { method: "POST" })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d.error || "Could not acknowledge"); return }
      toast.success("Notice acknowledged")
      mutate()
      onChanged?.()
    } finally {
      setAcking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <span className="truncate">{n?.heading ?? "Notice"}</span>
          </DialogTitle>
          <DialogDescription>{n?.notice_code ? `Ref ${n.notice_code}` : "Notice details"}</DialogDescription>
        </DialogHeader>

        {isLoading || !n ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto px-6 py-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={n.status} />
              <PriorityBadge priority={n.priority} />
              <Badge variant="secondary" className="font-normal">{n.category}</Badge>
              {n.pinned && <Badge variant="outline">Pinned</Badge>}
              {n.acknowledgement_required && <Badge variant="outline">Acknowledgement required</Badge>}
            </div>

            {n.status === "cancelled" && n.cancel_reason && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                Cancelled: {n.cancel_reason}
              </div>
            )}

            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{n.description || "No content."}</p>

            {n.attachments.length > 0 && (
              <div className="grid gap-1.5">
                <p className="text-sm font-medium">Attachments</p>
                {n.attachments.map((a) => (
                  <a
                    key={a.id}
                    href={`/api/notice-board/attachments/${a.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/40"
                  >
                    <FileText className="size-4 text-muted-foreground" />
                    <span className="flex-1 truncate">{a.file_name}</span>
                    <span className="text-xs text-muted-foreground">{(a.file_size / 1024).toFixed(0)} KB</span>
                    <Download className="size-4 text-muted-foreground" />
                  </a>
                ))}
              </div>
            )}

            <Separator />

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Row label="Audience" value={audienceSummary(n.to_type, n.audience_type, n.audience_config)} />
              <Row label="Created by" value={n.created_by_name ?? "—"} />
              <Row label="Published" value={formatDateTime(n.published_at ?? n.publish_date)} />
              <Row label="Expires" value={formatDate(n.end_date)} />
              {n.effective_date && <Row label="Effective" value={formatDate(n.effective_date)} />}
              {n.review_date && <Row label="Review" value={formatDate(n.review_date)} />}
              <Row label="Version" value={`v${n.version}`} />
              {n.updated_by_name && <Row label="Last edited by" value={n.updated_by_name} />}
            </dl>

            {canManage && n.versions && n.versions.length > 0 && (
              <>
                <Separator />
                <div className="grid gap-1.5">
                  <p className="flex items-center gap-1.5 text-sm font-medium"><History className="size-4" /> Version history</p>
                  <ul className="grid gap-1 text-xs text-muted-foreground">
                    {n.versions.map((v) => (
                      <li key={v.version}>v{v.version} — {v.heading} · {v.edited_by_name ?? "—"} · {formatDateTime(v.edited_at)}</li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {canManage && n.audit && n.audit.length > 0 && (
              <>
                <Separator />
                <div className="grid gap-1.5">
                  <p className="text-sm font-medium">Activity log</p>
                  <ul className="grid gap-1 text-xs text-muted-foreground">
                    {n.audit.map((a, i) => (
                      <li key={i}>
                        <span className="font-medium text-foreground">{a.action}</span>
                        {a.detail ? ` — ${a.detail}` : ""} · {a.user_name ?? "system"} · {formatDateTime(a.created_at)}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </div>
        )}

        {n && !canManage && n.acknowledgement_required && (
          <DialogFooter className="border-t px-6 py-4">
            {n.is_acknowledged ? (
              <Badge className="gap-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <Check className="size-3" /> You acknowledged this notice
              </Badge>
            ) : (
              <Button onClick={acknowledge} disabled={acking}>
                {acking ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Check className="mr-2 size-4" />}
                Acknowledge
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}
