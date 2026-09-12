"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { fetcher } from "@/lib/fetcher"
import { HrEmailStatusBadge } from "@/components/hr/hr-email-status-badge"

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  )
}

export function HrEmailDetailDialog({
  emailId,
  onClose,
  onChanged,
}: {
  emailId: number | null
  onClose: () => void
  onChanged: () => void
}) {
  const { data, mutate, isLoading } = useSWR<{ email: any }>(
    emailId ? `/api/hr/emails/${emailId}` : null,
    fetcher,
  )
  const [busy, setBusy] = useState(false)
  const email = data?.email

  async function act(action: "resend" | "cancel" | "send") {
    if (!emailId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/hr/emails/${emailId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Action failed")
      toast.success(
        action === "cancel" ? "Email cancelled" : json.status === "Sent" ? "Email sent" : `Status: ${json.status}`,
      )
      mutate()
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed")
    } finally {
      setBusy(false)
    }
  }

  const pending = email && ["Draft", "Scheduled", "Queued", "Failed"].includes(email.status)

  return (
    <Dialog open={emailId != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-sm">{email?.email_uid || "Email"}</span>
            {email && <HrEmailStatusBadge status={email.status} />}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !email ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-4">
              <Field label="To" value={`${email.to_name ? `${email.to_name} · ` : ""}${email.to_email}`} />
              <Field label="Category" value={email.category} />
              <Field label="CC" value={email.cc} />
              <Field label="BCC" value={email.bcc} />
              <Field label="Type" value={email.email_type} />
              <Field
                label="Source"
                value={
                  email.source_module === "manual"
                    ? "Manual"
                    : `${email.source_module}${email.source_record_id ? ` · ${email.source_record_id}` : ""}`
                }
              />
              <Field
                label="Opens"
                value={`${email.open_count || 0}${email.opened_at ? ` · first ${new Date(email.opened_at).toLocaleString()}` : ""}`}
              />
              <Field
                label={email.scheduled_at ? "Scheduled for" : "Date"}
                value={new Date(email.scheduled_at || email.sent_at).toLocaleString()}
              />
              <Field label="Attempts" value={email.attempts} />
              <Field label="Attachment" value={email.attachment_name} />
            </dl>

            {email.last_error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {email.last_error}
              </p>
            )}

            <div className="space-y-1.5">
              <p className="text-sm font-medium">{email.subject}</p>
              <div
                className="rounded-md border bg-background p-4 text-sm [&_a]:text-primary [&_a]:underline"
                // Rendering stored HR email HTML authored internally.
                dangerouslySetInnerHTML={{ __html: email.body }}
              />
            </div>

            {pending && (
              <div className="flex flex-wrap gap-2">
                {email.status === "Draft" || email.status === "Scheduled" ? (
                  <Button size="sm" disabled={busy} onClick={() => act("send")}>
                    Send now
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy} onClick={() => act("resend")}>
                    Retry send
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act("cancel")}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
