"use client"

import { useState } from "react"
import useSWR from "swr"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fetcher } from "@/lib/fetcher"
import {
  EMAIL_HUB_STATUSES,
  EMAIL_HUB_UI,
  type EmailHubModuleKey,
} from "@/lib/email-hub-shared"
import { ConnectEmailPanel } from "@/components/connect-email-panel"
import { EmailHubComposer } from "@/components/email-hub/email-hub-composer"
import { EmailHubAnalytics } from "@/components/email-hub/email-hub-analytics"
import { EmailHubAutomationSettings } from "@/components/email-hub/email-hub-automation-settings"
import { EmailHubStatusBadge } from "@/components/email-hub/email-hub-status-badge"
import { EmailHubDetailDialog } from "@/components/email-hub/email-hub-detail-dialog"

type Summary = {
  total: number
  sent: number
  failed: number
  pending: number
  drafts: number
  opened: number
}

type EmailsResponse = {
  emails: any[]
  total: number
  page: number
  pageSize: number
  configured: boolean
  summary: Summary
}

const PAGE_SIZE = 25

export function EmailHub({ moduleKey }: { moduleKey: EmailHubModuleKey }) {
  const config = EMAIL_HUB_UI[moduleKey]

  const [tab, setTab] = useState("compose")
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const [category, setCategory] = useState("all")
  const [page, setPage] = useState(1)
  const [detailId, setDetailId] = useState<number | null>(null)

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
  if (q.trim()) params.set("q", q.trim())
  if (status !== "all") params.set("status", status)
  if (category !== "all") params.set("category", category)

  const { data, mutate, isLoading } = useSWR<EmailsResponse>(
    `${config.apiBase}?${params.toString()}`,
    fetcher,
    { keepPreviousData: true },
  )

  const emails = data?.emails ?? []
  const summary = data?.summary
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const cards: { label: string; value: number; accent?: string }[] = summary
    ? [
        { label: "Total", value: summary.total },
        { label: "Sent", value: summary.sent, accent: "text-emerald-600 dark:text-emerald-400" },
        { label: "Opened", value: summary.opened, accent: "text-blue-600 dark:text-blue-400" },
        { label: "Pending", value: summary.pending, accent: "text-amber-600 dark:text-amber-400" },
        { label: "Drafts", value: summary.drafts },
        { label: "Failed", value: summary.failed, accent: "text-red-600 dark:text-red-400" },
      ]
    : []

  return (
    <main className="space-y-6 p-6">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">{config.breadcrumb}</p>
        <h1 className="text-3xl font-semibold">{config.title}</h1>
        <p className="text-muted-foreground">{config.description}</p>
      </header>

      <ConnectEmailPanel returnPath={config.returnPath} />

      {data && !data.configured && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
          Email transport is not configured yet. Emails can be drafted and scheduled but will fail
          to send until the mailbox is connected above.
        </p>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {cards.map((c) => (
            <div key={c.label} className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className={`mt-1 text-2xl font-semibold ${c.accent || ""}`}>{c.value}</p>
            </div>
          ))}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="compose">Compose</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="automation">Automation</TabsTrigger>
        </TabsList>

        <TabsContent value="compose">
          <EmailHubComposer
            config={config}
            onSent={() => {
              mutate()
              setTab("history")
            }}
          />
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search by ID, recipient or subject"
              value={q}
              onChange={(e) => {
                setPage(1)
                setQ(e.target.value)
              }}
              className="max-w-xs"
            />
            <Select
              value={status}
              onValueChange={(v) => {
                setPage(1)
                setStatus(v || "all")
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {EMAIL_HUB_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={category}
              onValueChange={(v) => {
                setPage(1)
                setCategory(v || "all")
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {config.categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-hidden rounded-xl border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Email ID</th>
                    <th className="px-4 py-3 font-medium">Recipient</th>
                    <th className="px-4 py-3 font-medium">Subject</th>
                    <th className="px-4 py-3 font-medium">Category</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Opens</th>
                    <th className="px-4 py-3 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {isLoading && emails.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                        Loading…
                      </td>
                    </tr>
                  ) : emails.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                        No emails found.
                      </td>
                    </tr>
                  ) : (
                    emails.map((row) => (
                      <tr
                        key={row.id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => setDetailId(row.id)}
                      >
                        <td className="px-4 py-3 font-mono text-xs">{row.email_uid || "—"}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{row.to_name || row.to_email}</div>
                          {row.to_name && (
                            <div className="text-xs text-muted-foreground">{row.to_email}</div>
                          )}
                        </td>
                        <td className="max-w-xs truncate px-4 py-3">{row.subject}</td>
                        <td className="px-4 py-3 text-muted-foreground">{row.category}</td>
                        <td className="px-4 py-3">
                          <EmailHubStatusBadge status={row.status} />
                        </td>
                        <td className="px-4 py-3 tabular-nums">{row.open_count || 0}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(
                            row.scheduled_at || row.sent_at || row.created_at,
                          ).toLocaleDateString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total} email{total === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span>
                Page {page} of {totalPages}
              </span>
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

        <TabsContent value="analytics">
          <EmailHubAnalytics config={config} />
        </TabsContent>

        <TabsContent value="automation">
          <EmailHubAutomationSettings config={config} />
        </TabsContent>
      </Tabs>

      <EmailHubDetailDialog
        config={config}
        emailId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => mutate()}
      />
    </main>
  )
}
