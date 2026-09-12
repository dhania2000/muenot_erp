"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fetcher } from "@/lib/fetcher"
import { HR_EMAIL_CATEGORIES, SENSITIVE_HR_EMAIL_CATEGORIES } from "@/lib/hr-email-shared"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"

type Recipient = {
  id: number
  employee_id: string
  employee_name: string
  email: string
  department: string | null
  designation: string | null
}

type Template = {
  id: number
  name: string
  subject: string
  body: string
  attachment_pathname?: string | null
  attachment_name?: string | null
  attachment_type?: string | null
  attachment_size?: number | null
}

const EMPTY = {
  subject: "",
  body: "",
  category: "General",
  cc: "",
  bcc: "",
  to_email: "",
  to_name: "",
}

export function HrEmailComposer({ onSent }: { onSent: () => void }) {
  const { data: recipData } = useSWR<{ recipients: Recipient[] }>(
    "/api/hr/emails/recipients",
    fetcher,
  )
  const { data: tplData } = useSWR<{ templates: Template[] }>("/api/hr/email-templates", fetcher)

  const [recipientMode, setRecipientMode] = useState<"employees" | "manual">("employees")
  const [selected, setSelected] = useState<Recipient[]>([])
  const [search, setSearch] = useState("")
  const [form, setForm] = useState({ ...EMPTY })
  const [attachment, setAttachment] = useState<EmailAttachment | null>(null)
  const [templateId, setTemplateId] = useState<string>("")
  const [showCc, setShowCc] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [scheduledAt, setScheduledAt] = useState("")
  const [busy, setBusy] = useState<null | "send" | "draft" | "schedule">(null)

  const recipients = recipData?.recipients ?? []
  const templates = tplData?.templates ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const chosen = new Set(selected.map((s) => s.id))
    return recipients
      .filter((r) => !chosen.has(r.id))
      .filter(
        (r) =>
          !q ||
          r.employee_name?.toLowerCase().includes(q) ||
          r.email?.toLowerCase().includes(q) ||
          r.employee_id?.toLowerCase().includes(q) ||
          (r.department || "").toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [recipients, selected, search])

  function applyTemplate(id: string) {
    setTemplateId(id)
    const tpl = templates.find((t) => String(t.id) === id)
    if (!tpl) return
    setForm((f) => ({ ...f, subject: tpl.subject, body: tpl.body }))
    if (tpl.attachment_pathname) {
      setAttachment({
        pathname: tpl.attachment_pathname,
        filename: tpl.attachment_name || "attachment",
        contentType: tpl.attachment_type || "application/octet-stream",
        size: tpl.attachment_size || 0,
      } as EmailAttachment)
    }
  }

  function reset() {
    setForm({ ...EMPTY })
    setSelected([])
    setAttachment(null)
    setTemplateId("")
    setScheduledAt("")
    setShowCc(false)
    setShowPreview(false)
  }

  async function submit(mode: "send" | "draft" | "schedule") {
    if (recipientMode === "employees" && selected.length === 0) {
      toast.error("Select at least one employee")
      return
    }
    if (recipientMode === "manual" && !form.to_email.trim()) {
      toast.error("Enter a recipient email")
      return
    }
    if (!form.subject.trim() || !form.body.trim()) {
      toast.error("Subject and body are required")
      return
    }
    if (mode === "schedule" && !scheduledAt) {
      toast.error("Pick a date and time to schedule")
      return
    }

    const payload: Record<string, unknown> = {
      mode,
      subject: form.subject,
      body: form.body,
      category: form.category,
      cc: form.cc || null,
      bcc: form.bcc || null,
      template_id: templateId ? Number(templateId) : null,
      attachment: attachment || null,
      scheduled_at: mode === "schedule" ? scheduledAt : null,
    }
    if (recipientMode === "employees") {
      if (selected.length > 1) payload.employee_ids = selected.map((s) => s.id)
      else payload.employee_id = selected[0].id
    } else {
      payload.to_email = form.to_email
      payload.to_name = form.to_name || null
    }

    setBusy(mode)
    try {
      const res = await fetch("/api/hr/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed")
      const label =
        mode === "send"
          ? "Email sent"
          : mode === "draft"
            ? "Draft saved"
            : "Email scheduled"
      const count = json.created ?? 1
      toast.success(count > 1 ? `${label} (${count} recipients)` : label)
      reset()
      onSent()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(null)
    }
  }

  const sensitive = SENSITIVE_HR_EMAIL_CATEGORIES.has(form.category)

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-5 rounded-xl border bg-card p-5">
        {/* Recipient selector */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Recipients</Label>
            <div className="flex rounded-md border p-0.5 text-xs">
              {(["employees", "manual"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setRecipientMode(m)}
                  className={`rounded px-2 py-1 capitalize transition-colors ${
                    recipientMode === m
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m === "employees" ? "Employees" : "Manual email"}
                </button>
              ))}
            </div>
          </div>

          {recipientMode === "employees" ? (
            <div className="space-y-2">
              {selected.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selected.map((r) => (
                    <Badge key={r.id} variant="secondary" className="gap-1">
                      {r.employee_name}
                      <button
                        type="button"
                        className="ml-1 text-muted-foreground hover:text-foreground"
                        onClick={() => setSelected((s) => s.filter((x) => x.id !== r.id))}
                        aria-label={`Remove ${r.employee_name}`}
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <Input
                placeholder="Search employees by name, ID, email or department"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search.trim() && filtered.length > 0 && (
                <div className="max-h-56 divide-y overflow-auto rounded-md border">
                  {filtered.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 p-2.5 text-left text-sm hover:bg-muted"
                      onClick={() => {
                        setSelected((s) => [...s, r])
                        setSearch("")
                      }}
                    >
                      <span>
                        <span className="font-medium">{r.employee_name}</span>{" "}
                        <span className="text-muted-foreground">· {r.email}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{r.department}</span>
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Selecting multiple employees sends a personalized copy to each and requires bulk
                permission. Use {"{{employee_name}}"}, {"{{department}}"} etc. in the body.
              </p>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder="Recipient email"
                value={form.to_email}
                onChange={(e) => setForm({ ...form, to_email: e.target.value })}
              />
              <Input
                placeholder="Recipient name (optional)"
                value={form.to_name}
                onChange={(e) => setForm({ ...form, to_name: e.target.value })}
              />
            </div>
          )}
        </div>

        {/* Template + category */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Template</Label>
            <Select value={templateId} onValueChange={(v) => v && applyTemplate(v)}>
              <SelectTrigger>
                <SelectValue placeholder="Start from a template" />
              </SelectTrigger>
              <SelectContent>
                {templates.length === 0 ? (
                  <SelectItem value="none" disabled>
                    No templates yet
                  </SelectItem>
                ) : (
                  templates.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select
              value={form.category}
              onValueChange={(v) => setForm({ ...form, category: v || "General" })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HR_EMAIL_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {sensitive && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
            This is a sensitive category. Sending requires the &quot;Send Sensitive HR Email&quot;
            permission.
          </p>
        )}

        {/* Subject */}
        <div className="space-y-1.5">
          <Label>Subject</Label>
          <Input
            placeholder="Subject line"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
          />
        </div>

        {/* CC/BCC */}
        {!showCc ? (
          <button
            type="button"
            className="text-xs font-medium text-primary hover:underline"
            onClick={() => setShowCc(true)}
          >
            + Add CC / BCC
          </button>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>CC</Label>
              <Input
                placeholder="comma separated"
                value={form.cc}
                onChange={(e) => setForm({ ...form, cc: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>BCC</Label>
              <Input
                placeholder="comma separated"
                value={form.bcc}
                onChange={(e) => setForm({ ...form, bcc: e.target.value })}
              />
            </div>
          </div>
        )}

        {/* Body */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>Body (HTML supported)</Label>
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => setShowPreview((p) => !p)}
            >
              {showPreview ? "Edit" : "Preview"}
            </button>
          </div>
          {showPreview ? (
            <div
              className="min-h-40 rounded-md border bg-background p-4 text-sm [&_a]:text-primary [&_a]:underline"
              // Preview of the composer's own trusted HTML content.
              dangerouslySetInnerHTML={{ __html: form.body || "<p class='text-muted-foreground'>Nothing to preview</p>" }}
            />
          ) : (
            <Textarea
              className="min-h-40"
              placeholder="Write your message. Use {{employee_name}} to personalize."
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          )}
        </div>

        <EmailAttachmentPicker value={attachment} onChange={setAttachment} />
      </div>

      {/* Actions rail */}
      <div className="space-y-4">
        <div className="space-y-3 rounded-xl border bg-card p-5">
          <h3 className="font-medium">Send options</h3>
          <Button
            className="w-full"
            disabled={busy !== null}
            onClick={() => submit("send")}
          >
            {busy === "send" ? "Sending…" : "Send now"}
          </Button>
          <div className="space-y-2 rounded-md border p-3">
            <Label className="text-xs">Schedule for later</Label>
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy !== null}
              onClick={() => submit("schedule")}
            >
              {busy === "schedule" ? "Scheduling…" : "Schedule"}
            </Button>
          </div>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy !== null}
            onClick={() => submit("draft")}
          >
            {busy === "draft" ? "Saving…" : "Save as draft"}
          </Button>
          <Button variant="ghost" className="w-full" disabled={busy !== null} onClick={reset}>
            Clear
          </Button>
        </div>
        <div className="rounded-xl border bg-muted/40 p-4 text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Personalization</p>
          <p>
            Available variables: {"{{employee_name}}"}, {"{{first_name}}"}, {"{{employee_id}}"},{" "}
            {"{{department}}"}, {"{{designation}}"}, {"{{reporting_manager}}"}, {"{{email}}"}.
          </p>
        </div>
      </div>
    </div>
  )
}
