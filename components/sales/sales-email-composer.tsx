"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CheckCircle2Icon, Loader2Icon } from "lucide-react"
import { fetcher } from "@/lib/fetcher"
import { handleHtmlSourcePaste } from "@/lib/utils"
import { SALES_EMAIL_CATEGORIES } from "@/lib/sales/sales-email-shared"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"

type Lead = {
  id: number
  contact_person: string | null
  company_name: string | null
  email: string | null
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

type MailType = "new" | "followup"

type ThreadPreview = {
  found: boolean
  thread?: {
    latestEmailId: number
    rootSubject: string
    replySubject: string
    sentAt: string | null
    toEmail: string
    providerThreaded: boolean
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const EMPTY = {
  subject: "",
  body: "",
  category: "General",
  cc: "",
  bcc: "",
  to_email: "",
  to_name: "",
}

export function SalesEmailComposer({ onSent }: { onSent: () => void }) {
  const { data: leadsData } = useSWR<{ leads: Lead[] }>("/api/sales/leads", fetcher)
  const { data: tplData } = useSWR<{ templates: Template[] }>("/api/sales/email-templates", fetcher)

  const [recipientMode, setRecipientMode] = useState<"lead" | "manual">("lead")
  const [leadId, setLeadId] = useState<string>("")
  const [search, setSearch] = useState("")
  const [mailType, setMailType] = useState<MailType>("new")
  const [form, setForm] = useState({ ...EMPTY })
  const [attachment, setAttachment] = useState<EmailAttachment | null>(null)
  const [templateId, setTemplateId] = useState<string>("")
  const [showCc, setShowCc] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [scheduledAt, setScheduledAt] = useState("")
  const [busy, setBusy] = useState<null | "send" | "draft" | "schedule">(null)
  const idempotencyKey = useRef<string>("")

  const leads = leadsData?.leads ?? []
  const templates = tplData?.templates ?? []

  useEffect(() => {
    idempotencyKey.current =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }, [])

  const filteredLeads = useMemo(() => {
    const q = search.trim().toLowerCase()
    return leads
      .filter((l) => l.email)
      .filter(
        (l) =>
          !q ||
          (l.contact_person || "").toLowerCase().includes(q) ||
          (l.company_name || "").toLowerCase().includes(q) ||
          (l.email || "").toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [leads, search])

  const selectedLead = useMemo(() => leads.find((l) => String(l.id) === leadId) || null, [leads, leadId])

  // Debounce the recipient address used for the follow-up thread lookup.
  const [debouncedEmail, setDebouncedEmail] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebouncedEmail(form.to_email.trim().toLowerCase()), 400)
    return () => clearTimeout(t)
  }, [form.to_email])

  const isFollowUp = mailType === "followup"
  const emailValid = EMAIL_RE.test(debouncedEmail)
  const previewKey =
    isFollowUp && emailValid
      ? `/api/sales/emails/thread-preview?email=${encodeURIComponent(debouncedEmail)}`
      : null
  const { data: preview, isLoading: previewLoading } = useSWR<ThreadPreview>(previewKey, fetcher)
  const hasThread = Boolean(isFollowUp && preview?.found && preview.thread)
  const noThread = isFollowUp && emailValid && !previewLoading && preview != null && !preview.found

  function pickLead(id: string) {
    setLeadId(id)
    const lead = leads.find((l) => String(l.id) === id)
    if (lead) {
      setForm((f) => ({
        ...f,
        to_email: lead.email || f.to_email,
        to_name: lead.contact_person || f.to_name,
      }))
    }
    setSearch("")
  }

  function applyTemplate(id: string) {
    setTemplateId(id)
    const tpl = templates.find((t) => String(t.id) === id)
    if (!tpl) return
    setForm((f) => ({
      ...f,
      // In Follow Up mode the thread owns the subject, so a template only fills the body.
      subject: mailType === "new" ? tpl.subject : f.subject,
      body: tpl.body,
    }))
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
    setLeadId("")
    setSearch("")
    setMailType("new")
    setAttachment(null)
    setTemplateId("")
    setScheduledAt("")
    setShowCc(false)
    setShowPreview(false)
    idempotencyKey.current =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  const effectiveSubject = hasThread ? preview!.thread!.replySubject : form.subject

  async function submit(mode: "send" | "draft" | "schedule") {
    if (!form.to_email.trim()) {
      toast.error("Enter a recipient email")
      return
    }
    if (!EMAIL_RE.test(form.to_email.trim())) {
      toast.error("Enter a valid recipient email")
      return
    }
    if (!isFollowUp && !form.subject.trim()) {
      toast.error("Subject is required for a new conversation")
      return
    }
    if (!form.body.trim()) {
      toast.error("Body is required")
      return
    }
    if (mode === "send" && isFollowUp && !hasThread) {
      toast.error("No previous conversation found. Send a New email first.")
      return
    }
    if (mode === "schedule" && !scheduledAt) {
      toast.error("Pick a date and time to schedule")
      return
    }

    const payload: Record<string, unknown> = {
      mode,
      lead_id: recipientMode === "lead" && leadId ? Number(leadId) : null,
      template_id: templateId ? Number(templateId) : null,
      mail_type: mailType,
      to_email: form.to_email.trim(),
      to_name: form.to_name.trim() || null,
      subject: effectiveSubject,
      body: form.body,
      category: form.category,
      cc: form.cc || null,
      bcc: form.bcc || null,
      attachment: attachment || null,
      scheduled_at: mode === "schedule" ? scheduledAt : null,
      reply_to_email_id: hasThread ? preview!.thread!.latestEmailId : null,
      idempotency_key: idempotencyKey.current,
    }

    setBusy(mode)
    try {
      const res = await fetch("/api/sales/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Failed")
      toast.success(
        json.deduped
          ? "Email already sent"
          : mode === "send"
            ? isFollowUp
              ? "Follow-up sent"
              : "Email sent"
            : mode === "draft"
              ? "Draft saved"
              : "Email scheduled",
      )
      reset()
      onSent()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-5 rounded-xl border bg-card p-5">
        {/* Mail type */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Mail type</Label>
            <Select value={mailType} onValueChange={(v) => setMailType((v as MailType) || "new")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New conversation</SelectItem>
                <SelectItem value="followup">Follow Up</SelectItem>
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
                {SALES_EMAIL_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Recipient selector */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Recipient</Label>
            <div className="flex rounded-md border p-0.5 text-xs">
              {(["lead", "manual"] as const).map((m) => (
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
                  {m === "lead" ? "From lead" : "Manual email"}
                </button>
              ))}
            </div>
          </div>

          {recipientMode === "lead" ? (
            <div className="space-y-2">
              {selectedLead && (
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="gap-1">
                    {selectedLead.contact_person || selectedLead.email}
                    {selectedLead.company_name ? ` · ${selectedLead.company_name}` : ""}
                    <button
                      type="button"
                      className="ml-1 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setLeadId("")
                        setForm((f) => ({ ...f, to_email: "", to_name: "" }))
                      }}
                      aria-label="Clear selected lead"
                    >
                      ×
                    </button>
                  </Badge>
                </div>
              )}
              {!selectedLead && (
                <>
                  <Input
                    placeholder="Search leads by name, company or email"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search.trim() && filteredLeads.length > 0 && (
                    <div className="max-h-56 divide-y overflow-auto rounded-md border">
                      {filteredLeads.map((l) => (
                        <button
                          key={l.id}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 p-2.5 text-left text-sm hover:bg-muted"
                          onClick={() => pickLead(String(l.id))}
                        >
                          <span>
                            <span className="font-medium">{l.contact_person || l.email}</span>{" "}
                            <span className="text-muted-foreground">· {l.email}</span>
                          </span>
                          <span className="text-xs text-muted-foreground">{l.company_name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Linking a lead fills the recipient and enables {"{{contact_person}}"},{" "}
                    {"{{company_name}}"} placeholders.
                  </p>
                </>
              )}
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

        {/* Follow Up thread preview */}
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
                  <span className="font-medium text-foreground">Previous conversation found</span> —
                  this reply threads into &quot;{preview!.thread!.rootSubject}&quot;.
                </AlertDescription>
              </Alert>
            ) : noThread ? (
              <Alert variant="destructive">
                <AlertDescription>
                  No previous sent conversation found for this recipient. Use New to start the first
                  email.
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}

        {/* Template */}
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

        {/* Subject */}
        <div className="space-y-1.5">
          <Label>Subject</Label>
          <Input
            placeholder="Subject line"
            value={effectiveSubject}
            readOnly={isFollowUp}
            disabled={isFollowUp && !hasThread}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
          />
          {isFollowUp && (
            <p className="text-xs text-muted-foreground">
              Thread subject is preserved automatically in Follow Up mode.
            </p>
          )}
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
              dangerouslySetInnerHTML={{
                __html: form.body || "<p class='text-muted-foreground'>Nothing to preview</p>",
              }}
            />
          ) : (
            <Textarea
              className="min-h-40"
              placeholder="Write your message. Use {{contact_person}} to personalize."
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              onPaste={(e) => handleHtmlSourcePaste(e, form.body, (next) => setForm({ ...form, body: next }))}
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
            disabled={busy !== null || (isFollowUp && (previewLoading || !hasThread))}
            onClick={() => submit("send")}
          >
            {busy === "send" ? "Sending…" : isFollowUp ? "Send follow-up" : "Send now"}
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
            Available variables: {"{{contact_person}}"}, {"{{company_name}}"}, {"{{email}}"},{" "}
            {"{{designation}}"}, {"{{country}}"}.
          </p>
        </div>
      </div>
    </div>
  )
}
