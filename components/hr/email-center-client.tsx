"use client"
import { useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { fetcher } from "@/lib/fetcher"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"

export function HrEmailCenter({ mode = "emails" }: { mode?: "emails" | "templates" }) {
  const { data, mutate } = useSWR<any>(mode === "emails" ? "/api/hr/emails" : "/api/hr/email-templates", fetcher)
  const [form, setForm] = useState({ name: "", to_email: "", to_name: "", subject: "", body: "", attachment: null as EmailAttachment | null })
  const [message, setMessage] = useState("")
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const endpoint = mode === "emails" ? "/api/hr/emails" : "/api/hr/email-templates"
    const payload = mode === "emails" ? form : { name: form.name, subject: form.subject, body: form.body, attachment: form.attachment }
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    const json = await res.json(); setMessage(json.error || "Saved successfully"); if (res.ok) { setForm({ name: "", to_email: "", to_name: "", subject: "", body: "", attachment: null }); mutate() }
  }
  const rows = mode === "emails" ? data?.emails ?? [] : data?.templates ?? []
  return <main className="space-y-6 p-6"><header><p className="text-sm text-muted-foreground">HR / Communication</p><h1 className="text-3xl font-semibold">{mode === "emails" ? "HR Emails" : "HR Email Templates"}</h1><p className="text-muted-foreground">{mode === "emails" ? "Send emails and monitor opens with tracking pixels." : "Create reusable HR communication templates."}</p></header>
    <form onSubmit={submit} className="grid gap-3 rounded-xl border bg-card p-5 md:grid-cols-2"><Input placeholder={mode === "emails" ? "Recipient email" : "Template name"} value={mode === "emails" ? form.to_email : form.name} onChange={e => setForm({ ...form, [mode === "emails" ? "to_email" : "name"]: e.target.value })} required />{mode === "emails" && <Input placeholder="Recipient name" value={form.to_name} onChange={e => setForm({ ...form, to_name: e.target.value })} />}<Input placeholder="Subject" value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} required /><Textarea className="md:col-span-2 min-h-32" placeholder="Email body (HTML supported)" value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} required /><EmailAttachmentPicker value={form.attachment} onChange={attachment => setForm({ ...form, attachment })} /><Button type="submit">{mode === "emails" ? "Send HR email" : "Save template"}</Button>{message && <p className="text-sm text-muted-foreground">{message}</p>}</form>
    <section className="overflow-hidden rounded-xl border"><div className="border-b p-4 font-medium">{mode === "emails" ? "Sent email history" : "Saved templates"}</div><div className="divide-y">{rows.map((row: any) => <div key={row.id} className="flex items-center justify-between gap-4 p-4"><div><p className="font-medium">{mode === "emails" ? row.subject : row.name}</p><p className="text-sm text-muted-foreground">{mode === "emails" ? `${row.to_email} · ${row.status}` : row.subject}</p></div>{mode === "emails" && <span className="text-xs text-muted-foreground">{row.open_count || 0} opens</span>}</div>)}</div></section></main>
}
