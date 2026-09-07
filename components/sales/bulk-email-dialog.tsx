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
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CheckCircle2Icon, Loader2Icon, Search, XCircleIcon } from "lucide-react"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"
import type { EmailTemplateRow } from "@/components/sales/email-templates-client"

type LeadRow = {
  id: number
  contact_person: string | null
  company_name: string | null
  email: string | null
}

type BulkResult = {
  to_email: string
  to_name: string | null
  status: "Sent" | "Failed"
  error?: string | null
}

export function BulkEmailDialog({
  open,
  onOpenChange,
  onSent,
  emailConfigured,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent: () => void
  emailConfigured: boolean
}) {
  const { data: leadsData } = useSWR<{ leads: LeadRow[] }>(open ? "/api/sales/leads" : null, fetcher)
  const { data: templatesData } = useSWR<{ templates: EmailTemplateRow[] }>(
    open ? "/api/sales/email-templates" : null,
    fetcher,
  )

  const [templateId, setTemplateId] = useState("")
  const [subject, setSubject] = useState("")
  const [emailBody, setEmailBody] = useState("")
  const [attachment, setAttachment] = useState<EmailAttachment | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [leadSearch, setLeadSearch] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<BulkResult[] | null>(null)

  const leads = leadsData?.leads ?? []
  const templates = templatesData?.templates ?? []
  const emailableLeads = useMemo(() => leads.filter((l) => l.email), [leads])

  useEffect(() => {
    if (open) return
    // Reset everything when the dialog closes.
    setTemplateId("")
    setSubject("")
    setEmailBody("")
    setAttachment(null)
    setSelected(new Set())
    setLeadSearch("")
    setError(null)
    setResults(null)
  }, [open])

  function onSelectTemplate(value: string | null) {
    const v = value ?? ""
    setTemplateId(v)
    const tpl = templates.find((t) => String(t.id) === v)
    if (tpl) {
      setSubject(tpl.subject)
      setEmailBody(tpl.body)
      setAttachment(
        tpl.attachment_pathname
          ? {
              pathname: tpl.attachment_pathname,
              filename: tpl.attachment_name ?? "attachment",
              contentType: tpl.attachment_type ?? "application/octet-stream",
              size: tpl.attachment_size ?? 0,
            }
          : null,
      )
    }
  }

  const filteredLeads = useMemo(() => {
    const q = leadSearch.trim().toLowerCase()
    if (!q) return emailableLeads
    return emailableLeads.filter((l) =>
      [l.contact_person, l.company_name, l.email]
        .filter(Boolean)
        .some((f) => f!.toLowerCase().includes(q)),
    )
  }, [emailableLeads, leadSearch])

  function toggleLead(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = filteredLeads.every((l) => next.has(l.id))
      if (allSelected) filteredLeads.forEach((l) => next.delete(l.id))
      else filteredLeads.forEach((l) => next.add(l.id))
      return next
    })
  }

  const allFilteredSelected = filteredLeads.length > 0 && filteredLeads.every((l) => selected.has(l.id))

  async function submit() {
    setError(null)
    if (selected.size === 0) {
      setError("Select at least one recipient.")
      return
    }
    if (!subject.trim() || !emailBody.trim()) {
      setError("Subject and body are required.")
      return
    }
    setLoading(true)
    try {
      const recipients = [...selected].map((id) => ({ lead_id: id }))
      const res = await fetch("/api/sales/emails/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: templateId ? Number(templateId) : null,
          subject,
          body: emailBody,
          attachment,
          recipients,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || "Failed to send emails.")
        return
      }
      setResults(data.results ?? [])
      if (data.failed > 0) {
        toast.warning(`Sent ${data.sent} of ${data.total} emails · ${data.failed} failed`)
      } else {
        toast.success(`Sent ${data.sent} email${data.sent === 1 ? "" : "s"}`)
      }
      onSent()
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
          <DialogTitle>Bulk email</DialogTitle>
          <DialogDescription>
            Send a personalized, tracked email to many leads at once. Each recipient gets their own message with
            {" {{"}placeholders{"}} "}filled from their lead record.
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

        {results ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mb-3 flex items-center gap-2 text-sm">
              <Badge variant="default" className="gap-1">
                <CheckCircle2Icon className="size-3.5" />
                {results.filter((r) => r.status === "Sent").length} sent
              </Badge>
              {results.some((r) => r.status === "Failed") && (
                <Badge variant="destructive" className="gap-1">
                  <XCircleIcon className="size-3.5" />
                  {results.filter((r) => r.status === "Failed").length} failed
                </Badge>
              )}
            </div>
            <ul className="flex flex-col gap-1">
              {results.map((r, i) => (
                <li
                  key={`${r.to_email}-${i}`}
                  className="flex items-start justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {r.to_name ? `${r.to_name} · ` : ""}
                    {r.to_email}
                  </span>
                  {r.status === "Sent" ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                      <CheckCircle2Icon className="size-3.5" /> Sent
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 text-destructive" title={r.error ?? ""}>
                      <XCircleIcon className="size-3.5" /> Failed
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <FieldGroup className="min-h-0 flex-1 overflow-y-auto">
            <Field>
              <FieldLabel htmlFor="bulk_template">Template (optional)</FieldLabel>
              <Select value={templateId} onValueChange={onSelectTemplate}>
                <SelectTrigger id="bulk_template" className="w-full">
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

            <Field>
              <FieldLabel>
                Recipients
                {selected.size > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {selected.size} selected
                  </Badge>
                )}
              </FieldLabel>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search leads..."
                  value={leadSearch}
                  onChange={(e) => setLeadSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
                  <Checkbox
                    id="bulk_select_all"
                    aria-label="Select all listed leads"
                    checked={allFilteredSelected}
                    onCheckedChange={toggleAllFiltered}
                  />
                  <label htmlFor="bulk_select_all" className="text-sm text-muted-foreground">
                    Select all {filteredLeads.length > 0 ? `(${filteredLeads.length})` : ""}
                  </label>
                </div>
                {filteredLeads.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">No leads with an email address.</p>
                ) : (
                  <ul>
                    {filteredLeads.map((l) => (
                      <li key={l.id}>
                        <label className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/50">
                          <Checkbox
                            aria-label={`Select ${l.contact_person || l.email}`}
                            checked={selected.has(l.id)}
                            onCheckedChange={() => toggleLead(l.id)}
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            <span className="font-medium">{l.contact_person || l.email}</span>
                            {l.company_name ? <span className="text-muted-foreground"> · {l.company_name}</span> : ""}
                          </span>
                          <span className="shrink-0 truncate text-xs text-muted-foreground">{l.email}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Field>

            <Field>
              <FieldLabel htmlFor="bulk_subject">Subject</FieldLabel>
              <Input
                id="bulk_subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject line"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="bulk_body">Body (HTML supported)</FieldLabel>
              <Textarea
                id="bulk_body"
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                onPaste={(e) => handleHtmlSourcePaste(e, emailBody, setEmailBody)}
                rows={9}
                placeholder="<p>Hi {{contact_person}},</p>"
              />
              <FieldDescription>
                Placeholders like {"{{contact_person}}"} and {"{{company_name}}"} are filled per recipient from their
                lead record.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>Attachment</FieldLabel>
              <EmailAttachmentPicker value={attachment} onChange={setAttachment} />
              <FieldDescription>Sent to every recipient. Prefilled from the selected template.</FieldDescription>
            </Field>
          </FieldGroup>
        )}

        <DialogFooter>
          {results ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={loading || !emailConfigured || selected.size === 0}>
                {loading && <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" />}
                Send to {selected.size || ""} {selected.size === 1 ? "recipient" : "recipients"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
