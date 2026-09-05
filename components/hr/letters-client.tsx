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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Mail, Plus, Eye, Printer, Trash2 } from "lucide-react"
import { LETTER_TYPES } from "@/lib/hr-letters"

type Letter = { id: number; letter_number: string; employee_name: string; employee_code: string; designation: string; department: string; letter_type: string; subject: string; body: string; issue_date: string; status: string }
type Template = { id: number; name: string; letter_type: string; subject: string; body: string }

const today = () => new Date().toISOString().slice(0, 10)
const emptyForm = { employee_id: "", template_id: "", letter_type: "Offer Letter", subject: "", body: "", issue_date: today(), status: "Draft" }

export function LettersClient() {
  const { data, mutate } = useSWR<{ letters: Letter[] }>("/api/hr/letters", fetcher)
  const { data: employeeData } = useSWR<{ employees: any[] }>("/api/hr/employees", fetcher)
  const { data: templateData } = useSWR<{ templates: Template[] }>("/api/hr/letter-templates", fetcher)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [preview, setPreview] = useState<Letter | null>(null)

  function openNew() { setForm({ ...emptyForm, issue_date: today() }); setError(""); setOpen(true) }
  function applyTemplate(value: string | null) {
    const id = value || ""
    const t = (templateData?.templates || []).find((x) => String(x.id) === id)
    setForm((f) => ({ ...f, template_id: id, letter_type: t?.letter_type ?? f.letter_type, subject: t?.subject ?? f.subject, body: t?.body ?? f.body }))
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError(""); setSaving(true)
    const res = await fetch("/api/hr/letters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) })
    setSaving(false)
    if (res.ok) { setOpen(false); mutate() } else { setError((await res.json().catch(() => ({}))).error || "Failed to save") }
  }
  async function remove(id: number) { if (!confirm("Delete this letter?")) return; await fetch(`/api/hr/letters?id=${id}`, { method: "DELETE" }); mutate() }

  function printLetter(l: Letter) {
    const w = window.open("", "_blank"); if (!w) return
    w.document.write(`<html><head><title>${l.letter_number}</title><style>body{font-family:Georgia,serif;max-width:760px;margin:40px auto;padding:0 24px;color:#111;line-height:1.7}h2{font-size:18px}.meta{color:#555;font-size:13px;margin-bottom:24px}.body{white-space:pre-wrap}</style></head><body><h2>${l.subject}</h2><div class="meta">Ref: ${l.letter_number} &nbsp;•&nbsp; Date: ${l.issue_date}</div><div class="body">${l.body.replace(/</g, "&lt;")}</div></body></html>`)
    w.document.close(); w.focus(); w.print()
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3"><Mail className="size-7 text-primary" /><h1 className="text-2xl font-semibold">Letters</h1></div>
          <p className="mt-1 text-sm text-muted-foreground">Issue letters to employees. Placeholders merge with employee and company details at creation.</p>
        </div>
        <Button onClick={openNew}><Plus data-icon="inline-start" />Issue letter</Button>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[900px] text-sm">
          <thead><tr className="border-b text-left text-muted-foreground">{["Ref", "Employee", "Type", "Subject", "Issued", "Status", ""].map((x) => <th key={x} className="px-4 py-3 font-medium">{x}</th>)}</tr></thead>
          <tbody>
            {(data?.letters || []).map((l) => (
              <tr key={l.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{l.letter_number}</td>
                <td className="px-4 py-3"><div className="font-medium">{l.employee_name}</div><div className="text-xs text-muted-foreground">{l.employee_code}</div></td>
                <td className="px-4 py-3">{l.letter_type}</td>
                <td className="px-4 py-3 text-muted-foreground">{l.subject}</td>
                <td className="px-4 py-3">{l.issue_date}</td>
                <td className="px-4 py-3"><Badge variant={l.status === "Issued" ? "default" : "secondary"}>{l.status}</Badge></td>
                <td className="px-4 py-3"><div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => setPreview(l)}><Eye className="size-4" /></Button><Button variant="outline" size="sm" onClick={() => printLetter(l)}><Printer className="size-4" /></Button><Button variant="outline" size="sm" onClick={() => remove(l.id)}><Trash2 className="size-4" /></Button></div></td>
              </tr>
            ))}
            {data && data.letters.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No letters issued yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Issue letter dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Issue letter</DialogTitle></DialogHeader>
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2"><Label>Employee</Label><Select value={form.employee_id} onValueChange={(v) => setForm({ ...form, employee_id: v || "" })}><SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger><SelectContent>{(employeeData?.employees || []).map((e) => <SelectItem key={e.id} value={String(e.id)}>{e.employee_id} · {e.employee_name}</SelectItem>)}</SelectContent></Select></div>
              <div className="grid gap-2"><Label>From template (optional)</Label><Select value={form.template_id} onValueChange={applyTemplate}><SelectTrigger><SelectValue placeholder="Start blank" /></SelectTrigger><SelectContent>{(templateData?.templates || []).map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2"><Label>Letter type</Label><Select value={form.letter_type} onValueChange={(v) => setForm({ ...form, letter_type: v || "Offer Letter" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{LETTER_TYPES.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></div>
              <div className="grid gap-2"><Label>Issue date</Label><Input type="date" value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} /></div>
            </div>
            <div className="grid gap-2"><Label>Subject</Label><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required /></div>
            <div className="grid gap-2"><Label>Body</Label><Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={9} placeholder="Dear {{employee_name}}, …" required /><p className="text-xs text-muted-foreground">Placeholders like {"{{employee_name}}"} are replaced with real values when the letter is created.</p></div>
            <div className="grid gap-2 md:w-1/2"><Label>Status</Label><Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v || "Draft" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Draft">Draft</SelectItem><SelectItem value="Issued">Issued</SelectItem></SelectContent></Select></div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={saving || !form.employee_id}>{saving ? "Creating…" : "Create letter"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog open={!!preview} onOpenChange={(v) => !v && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{preview?.subject}</DialogTitle></DialogHeader>
          {preview && (
            <div className="grid gap-4">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground"><span>Ref: <span className="font-mono">{preview.letter_number}</span></span><span>Employee: {preview.employee_name}</span><span>Date: {preview.issue_date}</span></div>
              <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-5 font-serif text-sm leading-relaxed">{preview.body}</div>
              <DialogFooter><Button variant="outline" onClick={() => setPreview(null)}>Close</Button><Button onClick={() => printLetter(preview)}><Printer data-icon="inline-start" />Print</Button></DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
