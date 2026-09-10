"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Mail, Plus, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { PageHeader } from "@/components/recruit/recruit-shared"
import { formatDateTime } from "@/lib/recruit"
import { RecruitComposeEmailDialog } from "@/components/recruit/recruit-compose-email-dialog"
import { ExcelExportButton } from "@/components/excel-export-button"

type EmailRow = {
  id: number
  application_id: string | null
  to_email: string
  to_name: string | null
  subject: string
  status: "Sent" | "Failed"
  error_message: string | null
  sent_at: string
  sent_by_name: string | null
}

export function RecruitEmailsClient() {
  const { data, isLoading, mutate } = useSWR<{ emails: EmailRow[]; emailConfigured: boolean }>(
    "/api/recruit/emails",
    fetcher,
  )
  const [search, setSearch] = useState("")
  const [composeOpen, setComposeOpen] = useState(false)

  const emails = data?.emails ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return emails
    return emails.filter((e) =>
      [e.to_email, e.to_name, e.subject].filter(Boolean).some((f) => f!.toLowerCase().includes(q)),
    )
  }, [emails, search])

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Email"
        description="Send emails to candidates and review everything that's gone out."
        icon={Mail}
        action={
          <div className="flex items-center gap-2">
            <ExcelExportButton
              rows={filtered}
              filename="recruit-emails"
              columns={[
                { header: "Recipient Name", value: (r) => r.to_name },
                { header: "Recipient Email", value: (r) => r.to_email },
                { header: "Subject", value: (r) => r.subject },
                { header: "Status", value: (r) => r.status },
                { header: "Application ID", value: (r) => r.application_id },
                { header: "Sent By", value: (r) => r.sent_by_name },
                { header: "Sent At", value: (r) => r.sent_at },
              ]}
            />
            <Button onClick={() => setComposeOpen(true)}>
              <Plus data-icon="inline-start" /> Compose email
            </Button>
          </div>
        }
      />

      {data && !data.emailConfigured && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
          Email is not configured yet. Set SMTP_HOST, SMTP_USER and SMTP_PASS in your environment to start sending.
        </div>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search sent emails..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 pl-8"
        />
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Recipient</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sent by</TableHead>
              <TableHead>Sent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  Loading emails...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No emails sent yet.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{e.to_name || e.to_email}</span>
                    {e.to_name && <span className="text-xs text-muted-foreground">{e.to_email}</span>}
                  </div>
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground" title={e.subject}>
                  {e.subject}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                      e.status === "Sent"
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                        : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
                    )}
                    title={e.error_message || undefined}
                  >
                    {e.status}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{e.sent_by_name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(e.sent_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <RecruitComposeEmailDialog open={composeOpen} onOpenChange={setComposeOpen} onSent={() => mutate()} />
    </main>
  )
}
