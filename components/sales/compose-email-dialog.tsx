"use client"

import { useEffect, useMemo, useState } from "react"
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
import { Loader2Icon } from "lucide-react"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"
import type { EmailTemplateRow } from "@/components/sales/email-templates-client"

type LeadRow = {
  id: number
  contact_person: string | null
  company_name: string | null
  email: string | null
}

type MailType = "new" | "followup"

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

export function ComposeEmailDialog({
  open,
  onOpenChange,
  onSent,
  emailConfigured,
  initialLead,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent: () => void
  emailConfigured: boolean
  initialLead?: LeadRow | null
}) {
  const { data: leadsData } = useSWR<{ leads: LeadRow[] }>(open ? "/api/sales/leads" : null, fetcher)
  const { data: templatesData } = useSWR<{ templates: EmailTemplateRow[] }>(
    open ? "/api/sales/email-templates" : null,
    fetcher,
  )
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const leads = leadsData?.leads ?? []
  const templates = templatesData?.templates ?? []

  useEffect(() => {
    if (!open) return
    setForm(initialLead ? { ...EMPTY, lead_id: String(initialLead.id), to_email: initialLead.email || "", to_name: initialLead.contact_person || "" } : EMPTY)
    setError(null)
  }, [open, initialLead])

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
      subject: tpl ? tpl.subject : prev.subject,
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

  const selectedLead = useMemo(
    () => leads.find((l) => String(l.id) === form.lead_id) || null,
    [leads, form.lead_id],
  )

  async function submit() {
    setError(null)
    if (!form.to_email.trim() || !form.subject.trim() || !form.body.trim()) {
      setError("Recipient, subject, and body are required.")
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
          subject: form.subject,
          body: form.body,
          attachment: form.attachment,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || "Failed to send email.")
        return
      }
      toast.success("Email sent")
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
              {form.mail_type === "followup"
                ? "Continues the last conversation with this recipient (threaded reply)."
                : "Starts a brand-new conversation, separate from any earlier emails."}
            </FieldDescription>
          </Field>

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
              <FieldDescription>Prefills the subject and body.</FieldDescription>
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
              value={form.subject}
              onChange={(e) => update("subject", e.target.value)}
              placeholder="Subject line"
            />
            {selectedLead && (
              <FieldDescription>
                If a conversation with this lead already exists, the subject will be threaded as a reply.
              </FieldDescription>
            )}
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
            <EmailAttachmentPicker
              value={form.attachment}
              onChange={(attachment) => update("attachment", attachment)}
            />
            <FieldDescription>Sent along with the email. Prefilled from the selected template.</FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={loading || !emailConfigured}>
            {loading && <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" />}
            Send email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
