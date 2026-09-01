"use client"
import { useState } from "react"
import useSWR from "swr"
import { EmailAttachmentPicker, type EmailAttachment } from "@/components/email-attachment-picker"
const fetcher=(u:string)=>fetch(u).then(r=>r.json())
export function ModuleEmailCenter({ module, mode = "emails" }: { module: "finance" | "operations"; mode?: "emails" | "templates" }) {
  const isTemplates = mode === "templates"
  const [form, setForm] = useState({ name: "", to: "", subject: "", body: "", attachment: null as EmailAttachment | null })
  const { data, mutate } = useSWR(`/api/${module}/${isTemplates ? "email-templates" : "emails"}`, fetcher)

  const submit = async () => {
    const payload = isTemplates ? { name: form.name, subject: form.subject, body: form.body, attachment: form.attachment } : { to: form.to, subject: form.subject, body: form.body, attachment: form.attachment }
    await fetch(`/api/${module}/${isTemplates ? "email-templates" : "emails"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
    setForm({ name: "", to: "", subject: "", body: "", attachment: null })
    mutate()
  }

  return <main className="space-y-6 p-6">
    <div><h1 className="text-2xl font-semibold">{module[0].toUpperCase() + module.slice(1)} {isTemplates ? "Email Templates" : "Emails"}</h1><p className="text-muted-foreground">{isTemplates ? `Create reusable templates for ${module} communication.` : "Send tracked emails and monitor opens."}</p></div>
    <section className="grid gap-3 rounded-xl border p-4">
      {isTemplates ? <input className="rounded border bg-background p-2" placeholder="Template name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /> : <input className="rounded border bg-background p-2" placeholder="Recipient email" value={form.to} onChange={e => setForm({ ...form, to: e.target.value })} />}
      <input className="rounded border bg-background p-2" placeholder="Subject" value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} />
      <textarea className="min-h-32 rounded border bg-background p-2" placeholder="Email body" value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} /><EmailAttachmentPicker value={form.attachment} onChange={attachment => setForm({ ...form, attachment })} />
      <button className="rounded bg-primary px-4 py-2 text-primary-foreground" onClick={submit}>{isTemplates ? "Save template" : "Send email"}</button>
    </section>
    <section className="rounded-xl border"><div className="border-b p-4 font-medium">{isTemplates ? "Saved templates" : "Email history"}</div>{(data?.[isTemplates ? "templates" : "emails"] ?? []).map((entry: any) => <div className="flex justify-between border-b p-4 text-sm" key={entry.id}><span>{isTemplates ? entry.name : entry.to_email}<br /><strong>{entry.subject}</strong></span><span>{isTemplates ? entry.status : `${entry.status} · ${entry.opened_at ? "Opened" : "Not opened"}`}</span></div>)}</section>
  </main>
}
