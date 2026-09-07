"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"
import { Send } from "lucide-react"

export type ComposeTarget = {
  applicationId?: string | null
  name?: string | null
  email?: string | null
  jobTitle?: string | null
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

export function RecruitComposeEmailDialog({
  open,
  onOpenChange,
  target,
  onSent,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target?: ComposeTarget | null
  onSent?: () => void
}) {
  const { data } = useSWR<{ templates: Template[] }>(open ? "/api/recruit/email-templates" : null, fetcher)
  const templates = data?.templates ?? []

  const [templateId, setTemplateId] = useState<string>("none")
  const [toEmail, setToEmail] = useState("")
  const [toName, setToName] = useState("")
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [attachment, setAttachment] = useState<EmailAttachment | null>(null)
  const [sending, setSending] = useState(false)

  // Seed recipient fields whenever the dialog opens for a given candidate.
  useEffect(() => {
    if (!open) return
    setToEmail(target?.email ?? "")
    setToName(target?.name ?? "")
    setTemplateId("none")
    setSubject("")
    setBody("")
    setAttachment(null)
  }, [open, target])

  function applyTemplate(id: string) {
    setTemplateId(id)
    if (id === "none") return
    const tpl = templates.find((t) => String(t.id) === id)
    if (!tpl) return
    setSubject(tpl.subject)
    setBody(tpl.body)
    if (tpl.attachment_pathname) {
      setAttachment({
        pathname: tpl.attachment_pathname,
        filename: tpl.attachment_name || "attachment",
        contentType: tpl.attachment_type || "application/octet-stream",
        size: tpl.attachment_size || 0,
      })
    } else {
      setAttachment(null)
    }
  }

  const canSend = useMemo(
    () => toEmail.trim() !== "" && subject.trim() !== "" && body.trim() !== "" && !sending,
    [toEmail, subject, body, sending],
  )

  async function send() {
    setSending(true)
    try {
      const res = await fetch("/api/recruit/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          application_id: target?.applicationId ?? null,
          template_id: templateId === "none" ? null : Number(templateId),
          to_email: toEmail.trim(),
          to_name: toName.trim() || null,
          subject,
          body,
          attachment,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success(`Email sent to ${toName || toEmail}`)
        onOpenChange(false)
        onSent?.()
      } else {
        toast.error(json.error || "Unable to send email")
      }
    } catch {
      toast.error("Unable to send email")
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send email</DialogTitle>
          <DialogDescription>
            {target?.jobTitle ? `Regarding ${target.jobTitle}. ` : ""}
            Use placeholders like {"{{candidate_name}}"} and {"{{job_title}}"} — they fill in automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label>Template</Label>
            <Select value={templateId} onValueChange={applyTemplate}>
              <SelectTrigger>
                <SelectValue placeholder="Start from scratch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Start from scratch</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recruit-email-to">To</Label>
              <Input
                id="recruit-email-to"
                type="email"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                placeholder="candidate@email.com"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recruit-email-name">Name</Label>
              <Input
                id="recruit-email-name"
                value={toName}
                onChange={(e) => setToName(e.target.value)}
                placeholder="Candidate name"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recruit-email-subject">Subject</Label>
            <Input id="recruit-email-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recruit-email-body">Message</Label>
            <Textarea
              id="recruit-email-body"
              rows={9}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message. Basic HTML is supported."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Attachment</Label>
            <EmailAttachmentPicker value={attachment} onChange={setAttachment} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={send} disabled={!canSend}>
            <Send data-icon="inline-start" />
            {sending ? "Sending..." : "Send email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
