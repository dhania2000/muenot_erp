"use client"

import useSWR from "swr"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { fetcher } from "@/lib/fetcher"
import type { EmailHubUiConfig } from "@/lib/email-hub-shared"
import { EmailHubStatusBadge } from "@/components/email-hub/email-hub-status-badge"

export function EmailHubDetailDialog({
  config,
  emailId,
  onClose,
  onChanged,
}: {
  config: EmailHubUiConfig
  emailId: number | null
  onClose: () => void
  onChanged: () => void
}) {
  const { data, isLoading, mutate } = useSWR<{ email: any }>(
    emailId ? `${config.apiBase}/${emailId}` : null,
    fetcher,
  )
  const email = data?.email

  async function act(action: "send" | "cancel") {
    if (!emailId) return
    try {
      const res = await fetch(`${config.apiBase}/${emailId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed")
      toast.success(action === "send" ? "Email sent" : "Email cancelled")
      mutate()
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong")
    }
  }

  return (
    <Dialog open={emailId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {email?.email_uid || "Email"}
            </span>
            {email && <EmailHubStatusBadge status={email.status} />}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !email ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="To">
                {email.to_name ? `${email.to_name} · ${email.to_email}` : email.to_email}
              </Field>
              <Field label="Category">{email.category}</Field>
              {email.cc && <Field label="CC">{email.cc}</Field>}
              {email.bcc && <Field label="BCC">{email.bcc}</Field>}
              <Field label="Type">{email.email_type}</Field>
              <Field label="Opens">{email.open_count || 0}</Field>
              {email.scheduled_at && (
                <Field label="Scheduled">
                  {new Date(email.scheduled_at).toLocaleString()}
                </Field>
              )}
              <Field label="Date">
                {new Date(email.sent_at || email.created_at).toLocaleString()}
              </Field>
            </div>

            {email.last_error && (
              <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                {email.last_error}
              </p>
            )}

            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Subject</p>
              <p className="font-medium">{email.subject}</p>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Body</p>
              <div
                className="rounded-md border bg-background p-4 [&_a]:text-primary [&_a]:underline"
                // Stored HTML that this app composed and sent.
                dangerouslySetInnerHTML={{ __html: email.body }}
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {email && ["Draft", "Scheduled", "Queued", "Failed"].includes(email.status) && (
            <Button onClick={() => act("send")}>Send now</Button>
          )}
          {email && ["Draft", "Scheduled", "Queued"].includes(email.status) && (
            <Button variant="outline" onClick={() => act("cancel")}>
              Cancel email
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="break-words">{children}</p>
    </div>
  )
}
