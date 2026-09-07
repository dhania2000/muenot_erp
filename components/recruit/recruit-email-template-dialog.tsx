"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
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
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"

export type RecruitTemplateRow = {
  id: number
  name: string
  subject: string
  body: string
  category: string | null
  attachment_pathname?: string | null
  attachment_name?: string | null
  attachment_type?: string | null
  attachment_size?: number | null
}

export function RecruitEmailTemplateDialog({
  open,
  onOpenChange,
  template,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  template: RecruitTemplateRow | null
  onSaved: () => void
}) {
  const [name, setName] = useState("")
  const [category, setCategory] = useState("")
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [attachment, setAttachment] = useState<EmailAttachment | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(template?.name ?? "")
    setCategory(template?.category ?? "")
    setSubject(template?.subject ?? "")
    setBody(template?.body ?? "")
    setAttachment(
      template?.attachment_pathname
        ? {
            pathname: template.attachment_pathname,
            filename: template.attachment_name || "attachment",
            contentType: template.attachment_type || "application/octet-stream",
            size: template.attachment_size || 0,
          }
        : null,
    )
  }, [open, template])

  async function save() {
    if (!name.trim() || !subject.trim() || !body.trim()) {
      toast.error("Name, subject, and body are required")
      return
    }
    setSaving(true)
    try {
      const payload = { name, subject, body, category: category || null, attachment }
      const res = await fetch(
        template ? `/api/recruit/email-templates/${template.id}` : "/api/recruit/email-templates",
        {
          method: template ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      )
      if (res.ok) {
        onSaved()
      } else {
        const json = await res.json().catch(() => ({}))
        toast.error(json.error || "Unable to save template")
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{template ? "Edit template" : "Create template"}</DialogTitle>
          <DialogDescription>
            Reusable email for candidates. Use {"{{candidate_name}}"} and {"{{job_title}}"} placeholders.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tpl-name">Name</Label>
              <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Interview invite" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tpl-category">Category</Label>
              <Input id="tpl-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Optional" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tpl-subject">Subject</Label>
            <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tpl-body">Body</Label>
            <Textarea id="tpl-body" rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Attachment</Label>
            <EmailAttachmentPicker value={attachment} onChange={setAttachment} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving..." : template ? "Save changes" : "Create template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
