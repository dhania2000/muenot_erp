"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { formatDateTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Eye, Plus, Search, Trash2, Users } from "lucide-react"
import { ComposeEmailDialog } from "@/components/sales/compose-email-dialog"
import { BulkEmailDialog } from "@/components/sales/bulk-email-dialog"
import { EmailDetailDialog } from "@/components/sales/email-detail-dialog"
import { SelectAllCheckbox, SelectionToolbar, useDeleteManager, useRowSelection } from "@/components/sales/bulk-delete"
import { ExcelExportButton } from "@/components/excel-export-button"

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
  const [bulkOpen, setBulkOpen] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)

  const emails = data?.emails ?? []
  const emailConfigured = data?.emailConfigured ?? false

  const { selected, toggle, toggleAll, clear } = useRowSelection()
  const del = useDeleteManager({
    endpoint: (id) => `/api/sales/emails/${id}`,
    labels: { singular: "email", plural: "emails" },
    mutate,
    onDeleted: clear,
  })

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
        <div className="flex items-center gap-2">
          <ExcelExportButton
            rows={filtered}
            filename="sales-emails"
            columns={[
              { header: "Subject", value: (r) => r.subject },
              { header: "Recipient Name", value: (r) => r.to_name },
              { header: "Recipient Email", value: (r) => r.to_email },
              { header: "Status", value: (r) => r.status },
              { header: "Opens", value: (r) => r.open_count },
              { header: "First Opened", value: (r) => r.first_opened_at },
              { header: "Last Opened", value: (r) => r.last_opened_at },
              { header: "Sent At", value: (r) => r.sent_at },
              { header: "Sent By", value: (r) => r.sent_by_name },
            ]}
          />
          {canSend && (
            <>
              <Button variant="outline" onClick={() => setBulkOpen(true)}>
                <Users data-icon="inline-start" />
                Bulk email
              </Button>
              <Button onClick={() => setComposeOpen(true)}>
                <Plus data-icon="inline-start" />
                Compose email
              </Button>
            </>
          )}
        </div>
      </div>

      {!emailConfigured && (
        <Alert>
          <AlertDescription>
            Email sending is not configured yet. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your environment to send
            tracked emails.
          </AlertDescription>
        </Alert>
      )}

      <SelectionToolbar
        count={selected.size}
        noun="email"
        onClear={clear}
        onDelete={() => del.requestBulk([...selected])}
      />

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <SelectAllCheckbox ids={filtered.map((e) => e.id)} selected={selected} onToggleAll={toggleAll} />
              </TableHead>
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
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Loading emails...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No emails sent yet.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((e) => {
              const threadCount = e.thread_id ? threadCounts.get(e.thread_id) ?? 1 : 1
              return (
                <TableRow
                  key={e.id}
                  className="cursor-pointer"
                  data-state={selected.has(e.id) ? "selected" : undefined}
                  onClick={() => setDetailId(e.id)}
                >
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select email ${e.subject}`}
                      checked={selected.has(e.id)}
                      onCheckedChange={() => toggle(e.id)}
                    />
                  </TableCell>
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
                      onClick={(event) => {
                        event.stopPropagation()
                        del.requestSingle(e.id, `the email "${e.subject}"`)
                      }}
                      aria-label={`Delete email ${e.subject}`}
                    >
                      <Trash2 className="size-4" />
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
      <BulkEmailDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onSent={() => mutate()}
        emailConfigured={emailConfigured}
      />
      <EmailDetailDialog
        emailId={detailId}
        onOpenChange={(open) => !open && setDetailId(null)}
        currentId={detailId}
        onSelect={(id) => setDetailId(id)}
      />

      {del.dialog}
    </div>
  )
}
