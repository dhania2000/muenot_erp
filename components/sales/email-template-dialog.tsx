"use client"

import { useEffect, useState } from "react"
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
import { Loader2Icon } from "lucide-react"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"
import { handleHtmlSourcePaste } from "@/lib/utils"
import type { EmailTemplateRow } from "@/components/sales/email-templates-client"

type FormState = {
  name: string
  category: string
  subject: string
  body: string
  attachment: EmailAttachment | null
}

const EMPTY: FormState = { name: "", category: "", subject: "", body: "", attachment: null }

export function EmailTemplateDialog({
  open,
  onOpenChange,
  template,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  template: EmailTemplateRow | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (template) {
      setForm({
        name: template.name || "",
        category: template.category || "",
        subject: template.subject || "",
        body: template.body || "",
        attachment: (template as any).attachment_pathname ? { pathname: (template as any).attachment_pathname, filename: (template as any).attachment_name, contentType: (template as any).attachment_type, size: (template as any).attachment_size } : null,
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, template])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name || !form.subject || !form.body) {
      setError("Name, subject, and body are required")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        template ? `/api/sales/email-templates/${template.id}` : "/api/sales/email-templates",
        {
          method: template ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        },
      )
      const b = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(b.error || "Unable to save template")
        setLoading(false)
        return
      }
      setLoading(false)
      onSaved()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{template ? "Edit template" : "Create template"}</DialogTitle>
            <DialogDescription>
              Use placeholders like {"{{contact_person}}"}, {"{{company_name}}"}, and {"{{email}}"} — they are
              replaced with the lead&apos;s details when you send.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <FieldGroup>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="name">Template name</FieldLabel>
                  <Input id="name" value={form.name} onChange={(e) => update("name", e.target.value)} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="category">Category</FieldLabel>
                  <Input
                    id="category"
                    placeholder="e.g. Outreach, Follow-up"
                    value={form.category}
                    onChange={(e) => update("category", e.target.value)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="subject">Subject</FieldLabel>
                <Input
                  id="subject"
                  value={form.subject}
                  onChange={(e) => update("subject", e.target.value)}
                  required
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="body">Body (HTML)</FieldLabel>
                <Textarea
                  id="body"
                  rows={12}
                  className="font-mono text-xs"
                  value={form.body}
                  onChange={(e) => update("body", e.target.value)}
                  onPaste={(e) => handleHtmlSourcePaste(e, form.body, (next) => update("body", next))}
                  required
                />
                <FieldDescription>
                  Basic HTML is supported. A hidden tracking pixel is added automatically when sending.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <EmailAttachmentPicker value={form.attachment} onChange={(attachment) => update("attachment", attachment)} />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              {template ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
