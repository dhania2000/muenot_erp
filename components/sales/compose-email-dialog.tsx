"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { handleHtmlSourcePaste } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CheckCircle2Icon, Loader2Icon } from "lucide-react"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"
import type { EmailTemplateRow } from "@/components/sales/email-templates-client"

type LeadRow = {
  id: number
  contact_person: string | null
  company_name: string | null
  email: string | null
}

type MailType = "new" | "followup"

type ThreadPreview = {
  found: boolean
  email?: string
  error?: string
  thread?: {
    latestEmailId: number
    threadId: string
    rootSubject: string
    replySubject: string
    sentAt: string | null
    toEmail: string
    toName: string | null
    openCount: number
    providerThreaded: boolean
  }
}

type FormState = {
  lead_id: string
  template_id: string
  mail_type: MailType
  to_email: string
  to_name: string
  subject: string
  body: string
  attachment: EmailAttachment | null
}

/**
 * Optional starting context when the composer is opened from a specific place
 * (e.g. the email detail dialog's "Follow up" / "New conversation" actions).
 * A replyToEmailId forces the follow-up to thread into that EXACT email's
 * conversation — the strongest, least-ambiguous follow-up path (spec 160/162) —
 * instead of re-discovering one by recipient address.
 */
export type ComposeInitial = {
  mailType?: MailType
  toEmail?: string
  toName?: string
  leadId?: number | null
  replyToEmailId?: number | null
}

const EMPTY: FormState = {
  lead_id: "",
  template_id: "",
  mail_type: "new",
  to_email: "",
  to_name: "",
  subject: "",
  body: "",
  attachment: null,
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function formatSentAt(value: string | null | undefined) {
  if (!value) return "—"
  const date = new Date(value.replace(" ", "T"))
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function ComposeEmailDialog({
  open,
  onOpenChange,
  onSent,
  emailConfigured,
  initialLead,
  initial,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent: () => void
  emailConfigured: boolean
  initialLead?: LeadRow | null
  initial?: ComposeInitial | null
}) {
  const { data: leadsData } = useSWR<{ leads: LeadRow[] }>(open ? "/api/sales/leads" : null, fetcher)
  const { data: templatesData } = useSWR<{ templates: EmailTemplateRow[] }>(
    open ? "/api/sales/email-templates" : null,
    fetcher,
  )
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // A stable de-duplication key for this compose session. Generated once per
  // dialog open and reused across double-clicks / retries so the server's
  // idempotency guard collapses accidental duplicates into a single send.
  const idempotencyKey = useRef<string>("")

  const leads = leadsData?.leads ?? []
  const templates = templatesData?.templates ?? []

  // When opened targeting a specific prior email (from the detail dialog's
  // "Follow up" action), force that email as the thread anchor so the reply
  // joins THAT exact conversation rather than the recipient's latest one.
  const forcedReplyToEmailId = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    if (initial) {
      setForm({
        ...EMPTY,
        mail_type: initial.mailType ?? "new",
        lead_id: initial.leadId != null ? String(initial.leadId) : "",
        to_email: initial.toEmail || "",
        to_name: initial.toName || "",
      })
      forcedReplyToEmailId.current = initial.replyToEmailId ?? null
    } else if (initialLead) {
      setForm({
        ...EMPTY,
        lead_id: String(initialLead.id),
        to_email: initialLead.email || "",
        to_name: initialLead.contact_person || "",
      })
      forcedReplyToEmailId.current = null
    } else {
      setForm(EMPTY)
      forcedReplyToEmailId.current = null
    }
    setError(null)
    idempotencyKey.current = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }, [open, initialLead, initial])

  // Debounce the recipient address used for the follow-up thread lookup so we
  // don't fire a request on every keystroke.
  const [debouncedEmail, setDebouncedEmail] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebouncedEmail(form.to_email.trim().toLowerCase()), 400)
    return () => clearTimeout(t)
  }, [form.to_email])

  const isFollowUp = form.mail_type === "followup"
  const emailValid = EMAIL_RE.test(debouncedEmail)

  // Resolve the conversation a Follow Up would join, live, as the recipient
  // changes. Only runs in Follow Up mode with a valid address.
  const previewKey =
    open && isFollowUp && emailValid ? `/api/sales/emails/thread-preview?email=${encodeURIComponent(debouncedEmail)}` : null
  const { data: preview, isLoading: previewLoading } = useSWR<ThreadPreview>(previewKey, fetcher)

  const hasThread = Boolean(isFollowUp && preview?.found && preview.thread)
  const noThread = isFollowUp && emailValid && !previewLoading && preview != null && !preview.found

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function onSelectLead(value: string | null) {
    const v = value ?? ""
    const lead = leads.find((l) => String(l.id) === v)
    setForm((prev) => ({
      ...prev,
      lead_id: v,
      to_email: lead?.email || prev.to_email,
      to_name: lead?.contact_person || prev.to_name,
    }))
  }

  function onSelectTemplate(value: string | null) {
    const v = value ?? ""
    const tpl = templates.find((t) => String(t.id) === v)
    setForm((prev) => ({
      ...prev,
      template_id: v,
      // In Follow Up mode the subject is owned by the thread, so a template only
      // ever changes the body — never the conversation subject.
      subject: tpl && prev.mail_type === "new" ? tpl.subject : prev.subject,
      body: tpl ? tpl.body : prev.body,
      attachment: tpl
        ? (tpl as any).attachment_pathname
          ? {
              pathname: (tpl as any).attachment_pathname,
              filename: (tpl as any).attachment_name,
              contentType: (tpl as any).attachment_type,
              size: (tpl as any).attachment_size,
            }
          : null
        : prev.attachment,
    }))
  }

  const selectedLead = useMemo(() => leads.find((l) => String(l.id) === form.lead_id) || null, [leads, form.lead_id])

  // The subject actually shown/sent. In Follow Up mode the server controls the
  // thread subject ("Re: <root>"), so we mirror that here read-only to prevent
  // accidental thread breakage.
  const effectiveSubject = hasThread ? preview!.thread!.replySubject : form.subject

  // Guard the Send button: block a Follow Up that has nothing to thread into.
  const sendDisabled =
    loading ||
    !emailConfigured ||
    (isFollowUp && (previewLoading || !hasThread)) ||
    !form.to_email.trim() ||
    !form.body.trim() ||
    (!isFollowUp && !form.subject.trim())

  async function submit() {
    setError(null)
    if (!form.to_email.trim() || !form.body.trim()) {
      setError("Recipient and body are required.")
      return
    }
    if (!isFollowUp && !form.subject.trim()) {
      setError("Subject is required for a new conversation.")
      return
    }
    if (isFollowUp && !hasThread) {
      setError("No previous sent conversation found for this recipient. Use New to start the first email.")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/sales/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: form.lead_id ? Number(form.lead_id) : null,
          template_id: form.template_id ? Number(form.template_id) : null,
          mail_type: form.mail_type,
          to_email: form.to_email.trim(),
          to_name: form.to_name.trim() || null,
          // In Follow Up mode the server rewrites the subject anyway; send the
          // effective one so history/logs match what the user saw.
          subject: effectiveSubject,
          body: form.body,
          attachment: form.attachment,
          // Strongest, unambiguous follow-up path: reply to a SPECIFIC prior
          // email. The server re-verifies this id, so a stale preview can't send.
          // A forced id (opened from a specific email) wins over the recipient's
          // latest thread resolved by the live preview.
          reply_to_email_id: forcedReplyToEmailId.current ?? (hasThread ? preview!.thread!.latestEmailId : null),
          idempotency_key: idempotencyKey.current,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || "Failed to send email.")
        return
      }
      toast.success(
        data.deduped
          ? "Email already sent"
          : form.mail_type === "followup"
            ? "Follow-up sent — threaded into the existing conversation"
            : "Email sent — new conversation started",
      )
      onSent()
      onOpenChange(false)
    } catch (err: any) {
      setError(String(err?.message || err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Compose email</DialogTitle>
          <DialogDescription>
            Send a tracked email. Choose &quot;New&quot; to start a fresh conversation or &quot;Follow Up&quot; to
            continue the recipient&apos;s most recent thread.
          </DialogDescription>
        </DialogHeader>

        {!emailConfigured && (
          <Alert variant="destructive">
            <AlertDescription>
              Email sending is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your environment.
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <FieldGroup className="min-h-0 flex-1 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor="mail_type">Mail type</FieldLabel>
            <Select value={form.mail_type} onValueChange={(v) => update("mail_type", (v as MailType) ?? "new")}>
              <SelectTrigger id="mail_type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="followup">Follow Up</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              {isFollowUp
                ? "Replies inside the recipient's most recent sent conversation."
                : "Starts a brand-new conversation."}
            </FieldDescription>
          </Field>

          {/* Follow Up thread preview: gives the sender confidence about exactly
              which conversation the reply will join before they send. */}
          {isFollowUp && emailValid && (
            <div>
              {previewLoading ? (
                <Alert>
                  <AlertDescription className="flex items-center gap-2">
                    <Loader2Icon className="size-4 animate-spin" />
                    Looking up the recipient&apos;s latest conversation…
                  </AlertDescription>
                </Alert>
              ) : hasThread ? (
                <Alert>
                  <CheckCircle2Icon className="size-4" />
                  <AlertDescription>
                    <div className="font-medium text-foreground">Previous conversation found</div>
                    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                      <dt className="text-muted-foreground">Recipient</dt>
                      <dd>{preview!.thread!.toEmail}</dd>
                      <dt className="text-muted-foreground">Last sent</dt>
                      <dd>{formatSentAt(preview!.thread!.sentAt)}</dd>
                      <dt className="text-muted-foreground">Subject</dt>
                      <dd>{preview!.thread!.rootSubject}</dd>
                      <dt className="text-muted-foreground">Thread</dt>
                      <dd>{preview!.thread!.providerThreaded ? "Ready (Gmail thread linked)" : "Ready"}</dd>
                    </dl>
                  </AlertDescription>
                </Alert>
              ) : noThread ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    No previous sent conversation found for this recipient. Use New to start the first email.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="lead">Link to lead (optional)</FieldLabel>
              <Select value={form.lead_id} onValueChange={onSelectLead}>
                <SelectTrigger id="lead" className="w-full">
                  <SelectValue placeholder="No lead" />
                </SelectTrigger>
                <SelectContent>
                  {leads
                    .filter((l) => l.email)
                    .map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>
                        {l.contact_person || l.email}
                        {l.company_name ? ` · ${l.company_name}` : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <FieldDescription>Fills recipient and enables {"{{"}placeholders{"}}"}.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="template">Template (optional)</FieldLabel>
              <Select value={form.template_id} onValueChange={onSelectTemplate}>
                <SelectTrigger id="template" className="w-full">
                  <SelectValue placeholder="Blank email" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {isFollowUp ? "Prefills the body only — the thread keeps its subject." : "Prefills the subject and body."}
              </FieldDescription>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="to_email">Recipient email</FieldLabel>
              <Input
                id="to_email"
                type="email"
                value={form.to_email}
                onChange={(e) => update("to_email", e.target.value)}
                placeholder="name@company.com"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="to_name">Recipient name</FieldLabel>
              <Input
                id="to_name"
                value={form.to_name}
                onChange={(e) => update("to_name", e.target.value)}
                placeholder="Jane Doe"
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="subject">Subject</FieldLabel>
            <Input
              id="subject"
              value={effectiveSubject}
              onChange={(e) => update("subject", e.target.value)}
              placeholder="Subject line"
              readOnly={isFollowUp}
              disabled={isFollowUp && !hasThread}
              aria-readonly={isFollowUp}
            />
            <FieldDescription>
              {isFollowUp
                ? "Thread subject is automatically preserved in Follow Up mode."
                : "This becomes the subject of the new conversation."}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="body">Body (HTML supported)</FieldLabel>
            <Textarea
              id="body"
              value={form.body}
              onChange={(e) => update("body", e.target.value)}
              onPaste={(e) => handleHtmlSourcePaste(e, form.body, (next) => update("body", next))}
              rows={10}
              placeholder="<p>Hi {{contact_person}},</p>"
            />
            <FieldDescription>
              Placeholders like {"{{contact_person}}"} and {"{{company_name}}"} are filled from the linked lead.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Attachment</FieldLabel>
            <EmailAttachmentPicker value={form.attachment} onChange={(attachment) => update("attachment", attachment)} />
            <FieldDescription>Sent along with the email. Prefilled from the selected template.</FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={sendDisabled}>
            {loading && <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" />}
            {isFollowUp ? "Send follow-up" : "Send email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
