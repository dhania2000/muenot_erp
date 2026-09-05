"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { formatDateTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Eye, Loader2, Plus, Search, Trash2 } from "lucide-react"
import { ComposeEmailDialog } from "@/components/sales/compose-email-dialog"
import { EmailDetailDialog } from "@/components/sales/email-detail-dialog"

export type EmailRow = {
  id: number
  lead_id: number | null
  to_email: string
  to_name: string | null
  subject: string
  status: string
  open_count: number
  first_opened_at: string | null
  last_opened_at: string | null
  error_message: string | null
  sent_at: string
  thread_id: string | null
  sent_by_name: string | null
  lead_contact: string | null
}

function statusVariant(status: string) {
  if (status === "Opened") return "default"
  if (status === "Failed") return "destructive"
  return "secondary"
}

export function EmailsClient({ canSend }: { canSend: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ emails: EmailRow[]; emailConfigured: boolean }>(
    "/api/sales/emails",
    fetcher,
  )
  const [search, setSearch] = useState("")
  const [composeOpen, setComposeOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const emails = data?.emails ?? []
  const emailConfigured = data?.emailConfigured ?? false

  async function handleDelete(e: EmailRow) {
    if (!window.confirm(`Delete this email "${e.subject}"? This cannot be undone.`)) return
    setDeletingId(e.id)
    try {
      const res = await fetch(`/api/sales/emails/${e.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete email")
      await mutate()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete email")
    } finally {
      setDeletingId(null)
    }
  }

  // Count how many emails belong to each thread so we can flag conversations.
  const threadCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of emails) {
      if (e.thread_id) map.set(e.thread_id, (map.get(e.thread_id) ?? 0) + 1)
    }
    return map
  }, [emails])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return emails
    return emails.filter((e) =>
      [e.subject, e.to_email, e.to_name, e.lead_contact]
        .filter(Boolean)
        .some((f) => f!.toLowerCase().includes(q)),
    )
  }, [emails, search])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search emails..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 pl-8"
          />
        </div>
        {canSend && (
          <Button onClick={() => setComposeOpen(true)}>
            <Plus data-icon="inline-start" />
            Compose email
          </Button>
        )}
      </div>

      {!emailConfigured && (
        <Alert>
          <AlertDescription>
            Email sending is not configured yet. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your environment to send
            tracked emails.
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Opens</TableHead>
              <TableHead>Last opened</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead className="w-12 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  Loading emails...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No emails sent yet.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((e) => {
              const threadCount = e.thread_id ? threadCounts.get(e.thread_id) ?? 1 : 1
              return (
                <TableRow key={e.id} className="cursor-pointer" onClick={() => setDetailId(e.id)}>
                  <TableCell className="max-w-xs">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{e.subject}</span>
                      {threadCount > 1 && (
                        <Badge variant="outline" className="shrink-0">
                          {threadCount} in thread
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {e.to_name ? `${e.to_name} · ` : ""}
                    {e.to_email}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      <Eye className="size-3.5 text-muted-foreground" />
                      {e.open_count}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {e.last_opened_at ? formatDateTime(e.last_opened_at) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(e.sent_at)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      disabled={deletingId === e.id}
                      onClick={(event) => {
                        event.stopPropagation()
                        void handleDelete(e)
                      }}
                      aria-label={`Delete email ${e.subject}`}
                    >
                      {deletingId === e.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <ComposeEmailDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={() => mutate()}
        emailConfigured={emailConfigured}
      />
      <EmailDetailDialog
        emailId={detailId}
        onOpenChange={(open) => !open && setDetailId(null)}
        currentId={detailId}
        onSelect={(id) => setDetailId(id)}
      />
    </div>
  )
}
