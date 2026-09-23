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
import { Eye, Plus, Search, Trash2, Users } from "lucide-react"
import { ComposeEmailDialog, type ComposeInitial } from "@/components/sales/compose-email-dialog"
import { BulkEmailDialog } from "@/components/sales/bulk-email-dialog"
import { EmailDetailDialog, type ComposeFromEmail } from "@/components/sales/email-detail-dialog"
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
  mail_type: string | null
  sent_by_name: string | null
  lead_contact: string | null
}

type MailTypeFilter = "all" | "new" | "followup"
type StatusFilter = "all" | "Sent" | "Opened" | "Failed"
type OpenedFilter = "all" | "opened" | "unopened"
type DateFilter = "all" | "today" | "7d" | "30d"

function statusVariant(status: string) {
  if (status === "Opened") return "default"
  if (status === "Failed") return "destructive"
  return "secondary"
}

function isFollowUp(mailType: string | null | undefined) {
  return mailType === "followup"
}

function withinRange(sentAt: string, filter: DateFilter) {
  if (filter === "all") return true
  const sent = new Date(sentAt.replace(" ", "T")).getTime()
  if (Number.isNaN(sent)) return true
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  if (filter === "today") return now - sent < day
  if (filter === "7d") return now - sent < 7 * day
  if (filter === "30d") return now - sent < 30 * day
  return true
}

export function EmailsClient({ canSend, canManage = false }: { canSend: boolean; canManage?: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ emails: EmailRow[]; emailConfigured: boolean }>(
    "/api/sales/emails",
    fetcher,
  )
  const [search, setSearch] = useState("")
  const [mailTypeFilter, setMailTypeFilter] = useState<MailTypeFilter>("all")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [openedFilter, setOpenedFilter] = useState<OpenedFilter>("all")
  const [dateFilter, setDateFilter] = useState<DateFilter>("all")
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeInitial, setComposeInitial] = useState<ComposeInitial | null>(null)
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
    return emails.filter((e) => {
      if (q && ![e.subject, e.to_email, e.to_name, e.lead_contact].filter(Boolean).some((f) => f!.toLowerCase().includes(q)))
        return false
      if (mailTypeFilter === "new" && isFollowUp(e.mail_type)) return false
      if (mailTypeFilter === "followup" && !isFollowUp(e.mail_type)) return false
      if (statusFilter !== "all" && e.status !== statusFilter) return false
      if (openedFilter === "opened" && e.open_count <= 0) return false
      if (openedFilter === "unopened" && e.open_count > 0) return false
      if (!withinRange(e.sent_at, dateFilter)) return false
      return true
    })
  }, [emails, search, mailTypeFilter, statusFilter, openedFilter, dateFilter])

  function openCompose(initial: ComposeInitial | null) {
    setComposeInitial(initial)
    setComposeOpen(true)
  }

  function composeFromEmail(init: ComposeFromEmail) {
    setDetailId(null)
    openCompose({
      mailType: init.mailType,
      toEmail: init.toEmail,
      toName: init.toName ?? undefined,
      leadId: init.leadId,
      replyToEmailId: init.replyToEmailId,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
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
              { header: "Type", value: (r) => (isFollowUp(r.mail_type) ? "Follow Up" : "New") },
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
              <Button onClick={() => openCompose(null)}>
                <Plus data-icon="inline-start" />
                Compose email
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Filters: mail type, status, opened, date range. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={mailTypeFilter} onValueChange={(v) => setMailTypeFilter(v as MailTypeFilter)}>
          <SelectTrigger className="w-36" aria-label="Filter by type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="followup">Follow Up</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-36" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="Sent">Sent</SelectItem>
            <SelectItem value="Opened">Opened</SelectItem>
            <SelectItem value="Failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={openedFilter} onValueChange={(v) => setOpenedFilter(v as OpenedFilter)}>
          <SelectTrigger className="w-36" aria-label="Filter by opened">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any opens</SelectItem>
            <SelectItem value="opened">Opened</SelectItem>
            <SelectItem value="unopened">Unopened</SelectItem>
          </SelectContent>
        </Select>
        <Select value={dateFilter} onValueChange={(v) => setDateFilter(v as DateFilter)}>
          <SelectTrigger className="w-36" aria-label="Filter by date">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">{filtered.length} of {emails.length}</span>
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
              <TableHead>Type</TableHead>
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
                <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                  Loading emails...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                  {emails.length === 0 ? "No emails sent yet." : "No emails match the current filters."}
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
                  <TableCell>
                    <Badge variant="outline">{isFollowUp(e.mail_type) ? "Follow Up" : "New"}</Badge>
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
        initial={composeInitial}
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
        canSend={canSend}
        canManage={canManage}
        onCompose={composeFromEmail}
      />

      {del.dialog}
    </div>
  )
}
