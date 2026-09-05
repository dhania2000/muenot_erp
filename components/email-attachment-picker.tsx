"use client"
import { useState } from "react"
import { Paperclip, X } from "lucide-react"
import { Button } from "@/components/ui/button"

export type EmailAttachment = { pathname: string; filename: string; contentType: string; size: number }
export function EmailAttachmentPicker({ value, onChange }: { value: EmailAttachment | null; onChange: (value: EmailAttachment | null) => void }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  async function upload(file?: File) {
    if (!file) return
    setLoading(true); setError("")
    const data = new FormData(); data.append("file", file)
    const res = await fetch("/api/email-attachments", { method: "POST", body: data })
    const json = await res.json()
    if (!res.ok) setError(json.error || "Upload failed"); else onChange(json)
    setLoading(false)
  }
  return <div className="space-y-2"><div className="flex items-center gap-2"><label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"><Paperclip className="size-4" /> {loading ? "Uploading..." : "Add attachment"}<input type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.doc,.docx,.xls,.xlsx" disabled={loading} onChange={e => upload(e.target.files?.[0])} /></label>{value && <span className="flex items-center gap-1 text-sm text-muted-foreground"><a href={value.pathname} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">{value.filename}</a><Button type="button" variant="ghost" size="icon-xs" onClick={() => onChange(null)} aria-label="Remove attachment"><X className="size-3" /></Button></span>}</div>{error && <p className="text-xs text-destructive">{error}</p>}</div>
}
