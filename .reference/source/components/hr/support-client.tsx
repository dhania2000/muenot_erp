"use client"
import { useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fetcher } from "@/lib/fetcher"

const priorities = ["Low", "Medium", "High", "Urgent"]
const statuses = ["Open", "In Progress", "Waiting", "Resolved", "Closed"]
export function SupportClient() {
  const { data, mutate } = useSWR<{ tickets: any[] }>("/api/hr/support", fetcher)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState("")
  const [form, setForm] = useState({ support_category: "Payroll", subject: "", description: "", priority: "Medium", employee_name: "", employee_remarks: "", attachment_path: "" })
  const tickets = data?.tickets || []
  const submit = async (e: React.FormEvent) => { e.preventDefault(); const res = await fetch("/api/hr/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }); if (res.ok) { setOpen(false); setForm({ support_category: "Payroll", subject: "", description: "", priority: "Medium", employee_name: "", employee_remarks: "", attachment_path: "" }); mutate() } }
  const update = async (id: number, next: string) => { await fetch("/api/hr/support", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: next }) }); mutate() }
  return <main className="space-y-6 p-6"><div className="flex items-center justify-between"><div><h1 className="text-2xl font-semibold">HR Support</h1><p className="text-muted-foreground">Employee helpdesk tickets, ownership, SLA, and resolution tracking.</p></div><Button onClick={() => setOpen(!open)}>New ticket</Button></div>
    {open && <form onSubmit={submit} className="grid gap-3 rounded-xl border bg-card p-5 md:grid-cols-2"><Input required placeholder="Employee name" value={form.employee_name} onChange={e => setForm({ ...form, employee_name: e.target.value })} /><Input required placeholder="Subject" value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} /><Input required placeholder="Support category" value={form.support_category} onChange={e => setForm({ ...form, support_category: e.target.value })} /><Select value={form.priority} onValueChange={v => setForm({ ...form, priority: v || "Medium" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{priorities.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select><Textarea required className="md:col-span-2" placeholder="Description" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /><Input className="md:col-span-2" placeholder="Employee remarks" value={form.employee_remarks} onChange={e => setForm({ ...form, employee_remarks: e.target.value })} /><Button type="submit">Create ticket</Button></form>}
    <div className="flex gap-2"><Select value={status} onValueChange={v => setStatus(v || "")}><SelectTrigger className="w-48"><SelectValue placeholder="All statuses" /></SelectTrigger><SelectContent>{statuses.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select></div>
    <div className="overflow-x-auto rounded-xl border"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-3">Ticket</th><th className="p-3">Employee</th><th className="p-3">Subject</th><th className="p-3">Priority</th><th className="p-3">Status</th><th className="p-3">SLA due</th></tr></thead><tbody>{tickets.filter(t => !status || t.status === status).map(t => <tr key={t.id} className="border-b"><td className="p-3 font-medium">{t.ticket_id}</td><td className="p-3">{t.employee_name || "—"}</td><td className="p-3">{t.subject}<div className="text-xs text-muted-foreground">{t.support_category}</div></td><td className="p-3">{t.priority}</td><td className="p-3"><Select value={t.status} onValueChange={v => v && update(t.id, v)}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent>{statuses.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select></td><td className="p-3 text-muted-foreground">{t.sla_due_date || "—"}</td></tr>)}</tbody></table></div>
  </main>
}
