"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2Icon } from "lucide-react"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"
import { handleHtmlSourcePaste } from "@/lib/utils"
import type { EmailTemplateRow } from "@/components/sales/email-templates-client"
import {
  groupedVariables,
  renderEmailTemplate,
  sampleContext,
  unknownVariables,
  SALES_TEMPLATE_MODULES,
  TEMPLATE_STATUSES,
  type TemplateStatus,
} from "@/lib/sales/email-template-engine"

type FormState = {
  name: string
  category: string
  module: string
  status: TemplateStatus
  description: string
  subject: string
  body: string
  attachment: EmailAttachment | null
}

const EMPTY: FormState = {
  name: "",
  category: "",
  module: "General",
  status: "Draft",
  description: "",
  subject: "",
  body: "",
  attachment: null,
}

type ActiveField = "subject" | "body"

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

  const subjectRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  // Remember which editable field (and cursor position) last had focus so the
  // variable palette inserts the placeholder exactly where the user was typing.
  const activeField = useRef<ActiveField>("body")
  const caret = useRef<Record<ActiveField, number>>({ subject: 0, body: 0 })

  useEffect(() => {
    if (!open) return
    setError(null)
    if (template) {
      setForm({
        name: template.name || "",
        category: template.category || "",
        module: template.module || "General",
        status: template.status || "Draft",
        description: template.description || "",
        subject: template.subject || "",
        body: template.body || "",
        attachment: template.attachment_pathname
          ? {
              pathname: template.attachment_pathname,
              filename: template.attachment_name || "",
              contentType: template.attachment_type || "",
              size: template.attachment_size || 0,
            }
          : null,
      })
    } else {
      setForm(EMPTY)
    }
  }, [open, template])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function rememberCaret(field: ActiveField, el: HTMLInputElement | HTMLTextAreaElement | null) {
    activeField.current = field
    if (el) caret.current[field] = el.selectionStart ?? el.value.length
  }

  function insertVariable(key: string) {
    const token = `{{${key}}}`
    const field = activeField.current
    setForm((prev) => {
      const current = prev[field]
      const pos = Math.min(caret.current[field] ?? current.length, current.length)
      const next = current.slice(0, pos) + token + current.slice(pos)
      caret.current[field] = pos + token.length
      return { ...prev, [field]: next }
    })
    // Restore focus + caret after the controlled update flushes.
    requestAnimationFrame(() => {
      const el = field === "subject" ? subjectRef.current : bodyRef.current
      if (el) {
        el.focus()
        const p = caret.current[field]
        el.setSelectionRange(p, p)
      }
    })
  }

  const sample = useMemo(() => sampleContext(), [])
  const previewSubject = useMemo(() => renderEmailTemplate(form.subject, sample), [form.subject, sample])
  const previewBody = useMemo(() => renderEmailTemplate(form.body, sample), [form.body, sample])
  const unknown = useMemo(
    () => [...new Set([...unknownVariables(form.subject), ...unknownVariables(form.body)])],
    [form.subject, form.body],
  )
  const groups = useMemo(() => groupedVariables(), [])

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
      <DialogContent className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{template ? "Edit template" : "Create template"}</DialogTitle>
          <DialogDescription>
            Insert variables from the palette. They resolve to each lead&apos;s details when the email is sent.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
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

              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="module">Module</FieldLabel>
                  <Select value={form.module} onValueChange={(v) => update("module", v ?? "General")}>
                    <SelectTrigger id="module" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SALES_TEMPLATE_MODULES.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="status">Status</FieldLabel>
                  <Select value={form.status} onValueChange={(v) => update("status", (v as TemplateStatus) ?? "Draft")}>
                    <SelectTrigger id="status" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEMPLATE_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>Only Active templates are offered when sending.</FieldDescription>
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="description">Description</FieldLabel>
                <Input
                  id="description"
                  placeholder="Short note about when to use this template"
                  value={form.description}
                  onChange={(e) => update("description", e.target.value)}
                />
              </Field>
            </FieldGroup>

            <Tabs defaultValue="edit" className="mt-4">
              <TabsList>
                <TabsTrigger value="edit">Edit</TabsTrigger>
                <TabsTrigger value="preview">Preview</TabsTrigger>
              </TabsList>

              <TabsContent value="edit" className="mt-4">
                <div className="grid gap-4 lg:grid-cols-[1fr_15rem]">
                  <FieldGroup className="min-w-0">
                    <Field>
                      <FieldLabel htmlFor="subject">Subject</FieldLabel>
                      <Input
                        id="subject"
                        ref={subjectRef}
                        value={form.subject}
                        onChange={(e) => update("subject", e.target.value)}
                        onFocus={(e) => rememberCaret("subject", e.currentTarget)}
                        onKeyUp={(e) => rememberCaret("subject", e.currentTarget)}
                        onClick={(e) => rememberCaret("subject", e.currentTarget)}
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="body">Body (HTML)</FieldLabel>
                      <Textarea
                        id="body"
                        ref={bodyRef}
                        rows={12}
                        className="font-mono text-xs"
                        value={form.body}
                        onChange={(e) => update("body", e.target.value)}
                        onFocus={(e) => rememberCaret("body", e.currentTarget)}
                        onKeyUp={(e) => rememberCaret("body", e.currentTarget)}
                        onClick={(e) => rememberCaret("body", e.currentTarget)}
                        onPaste={(e) => handleHtmlSourcePaste(e, form.body, (next) => update("body", next))}
                        required
                      />
                      <FieldDescription>
                        Supports fallbacks like {"{{"}first_name | there{"}}"} and conditional blocks like{" "}
                        {"{{"}#if company_name{"}}"}...{"{{"}/if{"}}"}.
                      </FieldDescription>
                    </Field>
                    {unknown.length > 0 && (
                      <Alert variant="destructive">
                        <AlertDescription>
                          Unrecognized variable{unknown.length > 1 ? "s" : ""}: {unknown.map((u) => `{{${u}}}`).join(", ")}. These
                          will render empty unless the value is provided when sending.
                        </AlertDescription>
                      </Alert>
                    )}
                  </FieldGroup>

                  <div className="flex min-w-0 flex-col rounded-lg border bg-muted/20">
                    <p className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Variable palette</p>
                    <div className="max-h-80 overflow-y-auto p-3">
                      <div className="flex flex-col gap-3">
                        {groups.map((g) => (
                          <div key={g.group}>
                            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">{g.group}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {g.variables.map((v) => (
                                <button
                                  key={v.key}
                                  type="button"
                                  title={v.description}
                                  onClick={() => insertVariable(v.key)}
                                  className="rounded-md border bg-background px-2 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                                >
                                  {v.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <EmailAttachmentPicker
                    value={form.attachment}
                    onChange={(attachment) => update("attachment", attachment)}
                  />
                </div>
              </TabsContent>

              <TabsContent value="preview" className="mt-4">
                <div className="rounded-lg border bg-card">
                  <div className="border-b px-4 py-3">
                    <p className="text-xs text-muted-foreground">Subject</p>
                    <p className="mt-0.5 font-medium">{previewSubject || <span className="text-muted-foreground">(empty)</span>}</p>
                  </div>
                  <div className="px-4 py-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Badge variant="outline">Sample data</Badge>
                      <span className="text-xs text-muted-foreground">Rendered with example values</span>
                    </div>
                    {form.body.trim() ? (
                      <div
                        className="prose prose-sm max-w-none dark:prose-invert"
                        // eslint-disable-next-line react/no-danger -- rendering the template preview for the author
                        dangerouslySetInnerHTML={{ __html: previewBody }}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">Add body content to see a preview.</p>
                    )}
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
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
