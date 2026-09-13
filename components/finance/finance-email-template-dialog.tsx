"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"
import {
  FINANCE_EMAIL_CATEGORIES,
  FINANCE_TEMPLATE_AUDIENCES,
  FINANCE_TEMPLATE_STATUSES,
  type FinanceEmailTemplate,
} from "@/lib/finance-email-shared"

const COMMON_VARIABLES = [
  "customer_name",
  "vendor_name",
  "company_name",
  "invoice_number",
  "invoice_date",
  "due_date",
  "amount",
  "amount_due",
  "currency",
  "gstin",
  "po_number",
  "payment_link",
  "period",
]

const SAMPLE_VALUES: Record<string, string> = {
  customer_name: "Acme Retail Pvt Ltd",
  vendor_name: "Sunrise Supplies",
  company_name: "Muenot Technologies",
  invoice_number: "INV-2026-0042",
  invoice_date: "01 Sep 2026",
  due_date: "15 Sep 2026",
  amount: "₹1,25,000",
  amount_due: "₹1,25,000",
  currency: "INR",
  gstin: "29ABCDE1234F1Z5",
  po_number: "PO-2026-0107",
  payment_link: "https://pay.muenot.co.in/inv/INV-2026-0042",
  period: "Aug 2026",
  tax_amount: "₹22,500",
}

type FormState = {
  name: string
  template_key: string
  description: string
  category: string
  audience: string
  subject: string
  body: string
  body_text: string
  status: string
  attachment: EmailAttachment | null
}

const EMPTY: FormState = {
  name: "",
  template_key: "",
  description: "",
  category: "General",
  audience: "Customer",
  subject: "",
  body: "",
  body_text: "",
  status: "Draft",
  attachment: null,
}

export function FinanceEmailTemplateDialog({
  open,
  onOpenChange,
  template,
  canManage,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  template: FinanceEmailTemplate | null
  canManage: boolean
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    if (template) {
      setForm({
        name: template.name,
        template_key: template.template_key || "",
        description: template.description || "",
        category: template.category || "General",
        audience: template.audience || "Customer",
        subject: template.subject,
        body: template.body,
        body_text: template.body_text || "",
        status: template.status,
        attachment: template.attachment_pathname
          ? {
              pathname: template.attachment_pathname,
              filename: template.attachment_name || "attachment",
              contentType: template.attachment_type || "application/octet-stream",
              size: template.attachment_size || 0,
            }
          : null,
      })
    } else {
      setForm(EMPTY)
    }
    setPreview(null)
  }, [open, template])

  function insertVariable(name: string) {
    const token = `{{${name}}}`
    const el = bodyRef.current
    if (!el) {
      setForm((f) => ({ ...f, body: f.body + token }))
      return
    }
    const start = el.selectionStart ?? form.body.length
    const end = el.selectionEnd ?? form.body.length
    const next = form.body.slice(0, start) + token + form.body.slice(end)
    setForm((f) => ({ ...f, body: next }))
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }

  async function runPreview() {
    const res = await fetch("/api/finance/email-templates/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: form.subject, body: form.body, sample: SAMPLE_VALUES }),
    })
    const json = await res.json()
    if (res.ok) setPreview({ subject: json.subject, body: json.body })
    else toast.error(json.error || "Unable to render preview")
  }

  async function save(nextStatus?: string) {
    if (!form.name.trim() || !form.subject.trim() || !form.body.trim()) {
      toast.error("Name, subject and body are required")
      return
    }
    setSaving(true)
    const payload = {
      ...form,
      status: nextStatus || form.status,
      template_key: form.template_key || null,
    }
    const url = template
      ? `/api/finance/email-templates/${template.id}`
      : "/api/finance/email-templates"
    const method = template ? "PATCH" : "POST"
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const json = await res.json().catch(() => ({}))
    setSaving(false)
    if (res.ok) {
      toast.success(template ? "Template updated" : "Template created")
      onSaved()
    } else {
      toast.error(json.error || "Unable to save template")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template ? "Edit template" : "Create template"}</DialogTitle>
          <DialogDescription>
            {template?.template_uid
              ? `${template.template_uid}${template.template_key ? ` · ${template.template_key}` : ""} · v${template.version}`
              : "Reusable finance email with variables, categories and lifecycle status."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Invoice due reminder — customer"
                disabled={!canManage}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-key">Template key (optional)</Label>
              <Input
                id="tpl-key"
                value={form.template_key}
                onChange={(e) => setForm({ ...form, template_key: e.target.value })}
                placeholder="INVOICE_DUE_REMINDER"
                disabled={!canManage}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="tpl-desc">Description</Label>
            <Input
              id="tpl-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Sent to a customer when an invoice is approaching its due date."
              disabled={!canManage}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v })}
                disabled={!canManage}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FINANCE_EMAIL_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Audience</Label>
              <Select
                value={form.audience}
                onValueChange={(v) => setForm({ ...form, audience: v })}
                disabled={!canManage}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FINANCE_TEMPLATE_AUDIENCES.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v })}
                disabled={!canManage}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FINANCE_TEMPLATE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="tpl-subject">Subject</Label>
            <Input
              id="tpl-subject"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder="Invoice {{invoice_number}} is due on {{due_date}}"
              disabled={!canManage}
            />
          </div>

          <Tabs defaultValue="body">
            <TabsList>
              <TabsTrigger value="body">HTML body</TabsTrigger>
              <TabsTrigger value="text">Plain text</TabsTrigger>
              <TabsTrigger value="preview" onClick={runPreview}>
                Preview
              </TabsTrigger>
            </TabsList>

            <TabsContent value="body" className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {COMMON_VARIABLES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVariable(v)}
                    disabled={!canManage}
                    className="rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
              <Textarea
                ref={bodyRef}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder="<p>Dear {{customer_name}},</p>"
                className="min-h-56 font-mono text-sm"
                disabled={!canManage}
              />
              <p className="text-xs text-muted-foreground">
                HTML is supported. Click a variable above to insert it at the cursor.
              </p>
            </TabsContent>

            <TabsContent value="text" className="space-y-2">
              <Textarea
                value={form.body_text}
                onChange={(e) => setForm({ ...form, body_text: e.target.value })}
                placeholder="Leave blank to auto-generate from the HTML body."
                className="min-h-56 text-sm"
                disabled={!canManage}
              />
              <p className="text-xs text-muted-foreground">
                Plain-text fallback for email clients that block HTML. Auto-generated if left blank.
              </p>
            </TabsContent>

            <TabsContent value="preview" className="space-y-2">
              {preview ? (
                <div className="rounded-md border border-border">
                  <div className="border-b border-border bg-muted/40 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Subject: </span>
                    <span className="font-medium">{preview.subject}</span>
                  </div>
                  <iframe
                    title="Template preview"
                    className="h-72 w-full bg-white"
                    srcDoc={preview.body}
                  />
                </div>
              ) : (
                <div className="flex h-72 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
                  Rendering preview with sample data…
                </div>
              )}
            </TabsContent>
          </Tabs>

          <div className="grid gap-1.5">
            <Label>Attachment (optional)</Label>
            <EmailAttachmentPicker
              value={form.attachment}
              onChange={(attachment) => setForm({ ...form, attachment })}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          {canManage && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => save("Draft")} disabled={saving}>
                Save as draft
              </Button>
              <Button onClick={() => save("Active")} disabled={saving}>
                {saving ? "Saving…" : "Save & activate"}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
