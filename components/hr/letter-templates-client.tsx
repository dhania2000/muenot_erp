"use client"
import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog"
import { FileText, Plus, Pencil, Trash2 } from "lucide-react"
import { LETTER_TYPES, LETTER_PLACEHOLDERS } from "@/lib/hr-letters"

type Template = { id: number; name: string; letter_type: string; subject: string; body: string; status: string }
const empty = { name: "", letter_type: "Offer Letter", subject: "", body: "", status: "Active" }

export function LetterTemplatesClient() {
  const { data, mutate } = useSWR<{ templates: Template[] }>("/api/hr/letter-templates", fetcher)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Template | null>(null)
  const [form, setForm] = useState<typeof empty>(empty)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  function openNew() { setEditing(null); setForm(empty); setError(""); setOpen(true) }
  function openEdit(t: Template) { setEditing(t); setForm({ name: t.name, letter_type: t.letter_type, subject: t.subject, body: t.body, status: t.status }); setError(""); setOpen(true) }
  function insertToken(token: string) { setForm((f) => ({ ...f, body: `${f.body}${token}` })) }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setError(""); setSaving(true)
    const res = await fetch("/api/hr/letter-templates", {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing ? { id: editing.id, ...form } : form),
    })
    setSaving(false)
    if (res.ok) { setOpen(false); mutate() } else { setError((await res.json().catch(() => ({}))).error || "Failed to save") }
  }
  async function remove(id: number) {
    if (!confirm("Delete this template?")) return
    await fetch(`/api/hr/letter-templates?id=${id}`, { method: "DELETE" }); mutate()
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3"><FileText className="size-7 text-primary" /><h1 className="text-2xl font-semibold">Letter Templates</h1></div>
          <p className="mt-1 text-sm text-muted-foreground">Reusable letter content with placeholders that auto-fill from employee and company data.</p>
        </div>
        <Button onClick={openNew}><Plus data-icon="inline-start" />New template</Button>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[720px] text-sm">
          <thead><tr className="border-b text-left text-muted-foreground">{["Name", "Type", "Subject", "Status", ""].map((x) => <th key={x} className="px-4 py-3 font-medium">{x}</th>)}</tr></thead>
          <tbody>
            {(data?.templates || []).map((t) => (
              <tr key={t.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-medium">{t.name}</td>
                <td className="px-4 py-3">{t.letter_type}</td>
                <td className="px-4 py-3 text-muted-foreground">{t.subject}</td>
                <td className="px-4 py-3"><Badge variant={t.status === "Active" ? "default" : "secondary"}>{t.status}</Badge></td>
                <td className="px-4 py-3"><div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => openEdit(t)}><Pencil className="size-4" /></Button><Button variant="outline" size="sm" onClick={() => remove(t.id)}><Trash2 className="size-4" /></Button></div></td>
              </tr>
            ))}
            {data && data.templates.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">No templates yet. Create your first one.</td></tr>}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{editing ? "Edit template" : "New template"}</DialogTitle></DialogHeader>
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Standard Offer Letter" required /></div>
              <div className="grid gap-2"><Label>Letter type</Label><Select value={form.letter_type} onValueChange={(v) => setForm({ ...form, letter_type: v || "Offer Letter" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{LETTER_TYPES.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="grid gap-2"><Label>Subject</Label><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="e.g. Offer of Employment — {{designation}}" required /></div>
            <div className="grid gap-2">
              <Label>Body</Label>
              <Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={10} placeholder="Dear {{employee_name}}, …" required />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {LETTER_PLACEHOLDERS.map((p) => <button type="button" key={p.token} onClick={() => insertToken(p.token)} className="rounded border bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground" title={p.label}>{p.token}</button>)}
              </div>
            </div>
            <div className="grid gap-2 md:w-1/2"><Label>Status</Label><Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v || "Active" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Active">Active</SelectItem><SelectItem value="Inactive">Inactive</SelectItem></SelectContent></Select></div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Create template"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
