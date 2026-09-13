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
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CornerUpLeft, Eye, MailOpen, MailPlus, Send } from "lucide-react"

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
  mail_type: string | null
}

type EmailDetail = {
  id: number
  lead_id: number | null
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
  mail_type: string | null
  thread_id: string | null
  provider_thread_id: string | null
  message_id: string | null
  in_reply_to: string | null
  references_header: string | null
}

export type ComposeFromEmail = {
  mailType: "new" | "followup"
  toEmail: string
  toName: string | null
  leadId: number | null
  replyToEmailId: number | null
}

function statusVariant(status: string) {
  if (status === "Opened") return "default"
  if (status === "Failed") return "destructive"
  return "secondary"
}

function isFollowUp(mailType: string | null | undefined) {
  return mailType === "followup"
}

export function EmailDetailDialog({
  emailId,
  onOpenChange,
  currentId,
  onSelect,
  canSend = false,
  canManage = false,
  onCompose,
}: {
  emailId: number | null
  onOpenChange: (open: boolean) => void
  currentId: number | null
  onSelect: (id: number) => void
  canSend?: boolean
  canManage?: boolean
  onCompose?: (init: ComposeFromEmail) => void
}) {
  const { data, isLoading } = useSWR<{ email: EmailDetail; events: EmailEvent[]; thread: ThreadItem[] }>(
    emailId ? `/api/sales/emails/${emailId}` : null,
    fetcher,
  )

  const email = data?.email
  const events = data?.events ?? []
  const thread = data?.thread ?? []

  function followUp() {
    if (!email || !onCompose) return
    onCompose({
      mailType: "followup",
      toEmail: email.to_email,
      toName: email.to_name,
      leadId: email.lead_id,
      replyToEmailId: email.id,
    })
  }

  function newConversation() {
    if (!email || !onCompose) return
    onCompose({
      mailType: "new",
      toEmail: email.to_email,
      toName: email.to_name,
      leadId: email.lead_id,
      replyToEmailId: null,
    })
  }

  return (
    <Dialog open={emailId != null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden">
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
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge variant={statusVariant(email.status)}>{email.status}</Badge>
              <Badge variant="outline">{isFollowUp(email.mail_type) ? "Follow Up" : "New"}</Badge>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Eye className="size-3.5" />
                {email.open_count} {email.open_count === 1 ? "open" : "opens"}
              </span>
              <span className="text-muted-foreground">Sent {formatDateTime(email.sent_at)}</span>
              {email.sent_by_name && <span className="text-muted-foreground">by {email.sent_by_name}</span>}
            </div>

            {canSend && onCompose && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={followUp}>
                  <CornerUpLeft data-icon="inline-start" />
                  Follow up
                </Button>
                <Button size="sm" variant="outline" onClick={newConversation}>
                  <MailPlus data-icon="inline-start" />
                  New conversation
                </Button>
              </div>
            )}

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
                  {thread.map((item) => (
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
                          <p className="truncate text-sm font-medium">{item.subject}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDateTime(item.sent_at)} · {item.open_count}{" "}
                            {item.open_count === 1 ? "open" : "opens"}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Badge variant="outline">{isFollowUp(item.mail_type) ? "Follow Up" : "Original"}</Badge>
                          <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </TabsContent>

              <TabsContent value="message" className="pt-2">
                <Separator className="mb-3" />
                <div className="w-full overflow-x-auto">
                  <div
                    className="prose prose-sm w-full max-w-none break-words text-sm leading-relaxed [&_img]:h-auto [&_img]:max-w-full [&_p]:my-2 [&_table]:w-full [&_table]:max-w-full [&_td]:break-words"
                    // The stored body is our own rendered template HTML.
                    dangerouslySetInnerHTML={{ __html: email.body }}
                  />
                </div>
              </TabsContent>
            </Tabs>

            {/* Threading diagnostics — collapsed by default and shown only to
                managers. Helps debug why a follow-up did or didn't thread. */}
            {canManage && (
              <details className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                <summary className="cursor-pointer select-none font-medium text-muted-foreground">
                  Technical details
                </summary>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all">
                  <dt className="text-muted-foreground">Thread ID</dt>
                  <dd className="font-mono text-xs">{email.thread_id || "—"}</dd>
                  <dt className="text-muted-foreground">Provider thread</dt>
                  <dd className="font-mono text-xs">{email.provider_thread_id || "—"}</dd>
                  <dt className="text-muted-foreground">Message-ID</dt>
                  <dd className="font-mono text-xs">{email.message_id || "—"}</dd>
                  <dt className="text-muted-foreground">In-Reply-To</dt>
                  <dd className="font-mono text-xs">{email.in_reply_to || "—"}</dd>
                  <dt className="text-muted-foreground">References</dt>
                  <dd className="font-mono text-xs">{email.references_header || "—"}</dd>
                </dl>
              </details>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
