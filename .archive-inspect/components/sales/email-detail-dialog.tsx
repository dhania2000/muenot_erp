"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { formatDateTime } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Eye, MailOpen, Send } from "lucide-react"

type EmailEvent = {
  id: number
  event_type: string
  user_agent: string | null
  ip_address: string | null
  created_at: string
}

type ThreadItem = {
  id: number
  subject: string
  status: string
  open_count: number
  sent_at: string
  to_email: string
  last_opened_at: string | null
}

type EmailDetail = {
  id: number
  to_email: string
  to_name: string | null
  subject: string
  body: string
  status: string
  open_count: number
  first_opened_at: string | null
  last_opened_at: string | null
  error_message: string | null
  sent_at: string
  sent_by_name: string | null
  lead_contact: string | null
}

function statusVariant(status: string) {
  if (status === "Opened") return "default"
  if (status === "Failed") return "destructive"
  return "secondary"
}

export function EmailDetailDialog({
  emailId,
  onOpenChange,
  currentId,
  onSelect,
}: {
  emailId: number | null
  onOpenChange: (open: boolean) => void
  currentId: number | null
  onSelect: (id: number) => void
}) {
  const { data, isLoading } = useSWR<{ email: EmailDetail; events: EmailEvent[]; thread: ThreadItem[] }>(
    emailId ? `/api/sales/emails/${emailId}` : null,
    fetcher,
  )

  const email = data?.email
  const events = data?.events ?? []
  const thread = data?.thread ?? []

  return (
    <Dialog open={emailId != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pr-8 text-pretty">{email?.subject || "Email"}</DialogTitle>
          <DialogDescription>
            {email
              ? `To ${email.to_name ? `${email.to_name} · ` : ""}${email.to_email}`
              : "Loading email details..."}
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>}

        {email && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge variant={statusVariant(email.status)}>{email.status}</Badge>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Eye className="size-3.5" />
                {email.open_count} {email.open_count === 1 ? "open" : "opens"}
              </span>
              <span className="text-muted-foreground">Sent {formatDateTime(email.sent_at)}</span>
              {email.sent_by_name && <span className="text-muted-foreground">by {email.sent_by_name}</span>}
            </div>

            {email.error_message && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {email.error_message}
              </p>
            )}

            <Tabs defaultValue="activity">
              <TabsList>
                <TabsTrigger value="activity">Activity ({events.length})</TabsTrigger>
                <TabsTrigger value="thread">Thread ({thread.length})</TabsTrigger>
                <TabsTrigger value="message">Message</TabsTrigger>
              </TabsList>

              <TabsContent value="activity" className="pt-2">
                {email.first_opened_at && (
                  <p className="mb-3 text-sm text-muted-foreground">
                    First opened {formatDateTime(email.first_opened_at)} · last opened{" "}
                    {formatDateTime(email.last_opened_at)}
                  </p>
                )}
                {events.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No opens recorded yet. Each time the recipient opens this email, it will appear here.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {events.map((ev) => (
                      <li
                        key={ev.id}
                        className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2"
                      >
                        <MailOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">Email opened</p>
                          <p className="text-xs text-muted-foreground">{formatDateTime(ev.created_at)}</p>
                          {ev.user_agent && (
                            <p className="truncate text-xs text-muted-foreground">{ev.user_agent}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="thread" className="pt-2">
                <ul className="flex flex-col gap-2">
                  {thread.map((item, idx) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(item.id)}
                        className={`flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                          item.id === currentId
                            ? "border-primary bg-primary/5"
                            : "border-border bg-card hover:bg-accent"
                        }`}
                      >
                        <Send className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {idx === 0 ? "" : "Re: "}
                            {item.subject}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDateTime(item.sent_at)} · {item.open_count}{" "}
                            {item.open_count === 1 ? "open" : "opens"}
                          </p>
                        </div>
                        <Badge variant={statusVariant(item.status)} className="shrink-0">
                          {item.status}
                        </Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              </TabsContent>

              <TabsContent value="message" className="pt-2">
                <Separator className="mb-3" />
                <div
                  className="prose prose-sm max-w-none text-sm leading-relaxed [&_p]:my-2"
                  // The stored body is our own rendered template HTML.
                  dangerouslySetInnerHTML={{ __html: email.body }}
                />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
