"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { formatDateTime } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { Button } from "@/components/ui/button"
import { Search } from "lucide-react"
import { SALES_EMAIL_CATEGORIES, SALES_EMAIL_STATUSES } from "@/lib/sales/sales-email-shared"
import { SalesEmailComposer } from "@/components/sales/sales-email-composer"
import { SalesEmailAnalytics } from "@/components/sales/sales-email-analytics"
import { SalesEmailAutomationSettings } from "@/components/sales/sales-email-automation-settings"
import { SalesEmailStatusBadge } from "@/components/sales/sales-email-status-badge"
import { EmailDetailDialog } from "@/components/sales/email-detail-dialog"
import { ConnectEmailPanel } from "@/components/connect-email-panel"

type EmailRow = {
  id: number
  lead_id: number | null
  to_email: string
  to_name: string | null
  subject: string
  status: string
  category: string | null
  email_type: string | null
  open_count: number
  scheduled_at: string | null
  sent_at: string | null
  mail_type: string | null
  sent_by_name: string | null
  lead_contact: string | null
}

type Summary = {
  total: number
  sent: number
  failed: number
  pending: number
  drafts: number
  opened: number
}

type EmailsResponse = {
  emails: EmailRow[]
  total: number
  page: number
  pageSize: number
  emailConfigured: boolean
  summary: Summary
}

const PAGE_SIZE = 25

const SUMMARY_CARDS: { key: keyof Summary; label: string; accent?: string }[] = [
  { key: "total", label: "Total" },
  { key: "sent", label: "Sent", accent: "text-emerald-600 dark:text-emerald-400" },
  { key: "opened", label: "Opened", accent: "text-blue-600 dark:text-blue-400" },
  { key: "pending", label: "Scheduled / queued", accent: "text-amber-600 dark:text-amber-400" },
  { key: "drafts", label: "Drafts", accent: "text-muted-foreground" },
  { key: "failed", label: "Failed", accent: "text-red-600 dark:text-red-400" },
]

export function SalesEmailHub({
  canSend,
  canManage,
}: {
  canSend: boolean
  canManage: boolean
}) {
  const [tab, setTab] = useState("compose")

  // History filters + pagination.
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const [category, setCategory] = useState("all")
  const [page, setPage] = useState(1)
  const [detailId, setDetailId] = useState<number | null>(null)

  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
  })
  if (q.trim()) params.set("q", q.trim())
  if (status !== "all") params.set("status", status)
  if (category !== "all") params.set("category", category)

  const { data, isLoading, mutate } = useSWR<EmailsResponse>(
    `/api/sales/emails?${params.toString()}`,
    fetcher,
    { keepPreviousData: true },
  )

  const emails = data?.emails ?? []
  const summary = data?.summary
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const emailConfigured = data?.emailConfigured ?? true

  function resetToFirstPage() {
    setPage(1)
  }

  function refresh() {
    mutate()
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Sales Email Hub</h2>
        <p className="text-sm text-muted-foreground">
          Compose tracked emails, review delivery history, and manage automated flows — all in one place.
        </p>
      </div>

      {!emailConfigured && (
        <Alert variant="destructive">
          <AlertDescription>
            Email sending is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your
            environment. You can still save drafts and schedule sends.
          </AlertDescription>
        </Alert>
      )}

      <ConnectEmailPanel returnPath="/modules/sales/emails" />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {SUMMARY_CARDS.map((c) => (
          <div key={c.key} className="rounded-xl border bg-card p-4">
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${c.accent || ""}`}>
              {summary ? summary[c.key] : "—"}
            </p>
          </div>
        ))}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="compose">Compose</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="automation">Automation</TabsTrigger>
        </TabsList>

        <TabsContent value="compose" className="mt-6">
          <SalesEmailComposer
            onSent={() => {
              refresh()
              setTab("history")
            }}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-6 space-y-4">
          {/* Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search recipient, subject or category"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  resetToFirstPage()
                }}
              />
            </div>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v || "all")
                resetToFirstPage()
              }}
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {SALES_EMAIL_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={category}
              onValueChange={(v) => {
                setCategory(v || "all")
                resetToFirstPage()
              }}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {SALES_EMAIL_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Table */}
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Opens</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && emails.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      Loading emails…
                    </TableCell>
                  </TableRow>
                ) : emails.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      No emails match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  emails.map((e) => (
                    <TableRow
                      key={e.id}
                      className="cursor-pointer"
                      onClick={() => setDetailId(e.id)}
                    >
                      <TableCell>
                        <div className="font-medium">{e.to_name || e.lead_contact || e.to_email}</div>
                        <div className="text-xs text-muted-foreground">{e.to_email}</div>
                      </TableCell>
                      <TableCell className="max-w-xs">
                        <div className="truncate">{e.subject}</div>
                        {e.mail_type === "followup" && (
                          <span className="text-xs text-muted-foreground">Follow-up</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">{e.category || "General"}</span>
                        {e.email_type === "Automated" && (
                          <span className="ml-1.5 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                            Auto
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <SalesEmailStatusBadge status={e.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{e.open_count || 0}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatDateTime(e.sent_at || e.scheduled_at || "") || "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total} email{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="mt-6">
          <SalesEmailAnalytics />
        </TabsContent>

        <TabsContent value="automation" className="mt-6">
          <SalesEmailAutomationSettings />
        </TabsContent>
      </Tabs>

      <EmailDetailDialog
        emailId={detailId}
        currentId={detailId}
        onOpenChange={(open) => {
          if (!open) setDetailId(null)
        }}
        onSelect={(id) => setDetailId(id)}
        canSend={canSend}
        canManage={canManage}
        onCompose={() => setTab("compose")}
      />
    </div>
  )
}
