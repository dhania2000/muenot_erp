"use client"

import useSWR from "swr"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { fetcher } from "@/lib/fetcher"

export function LeaveQuotaHistoryClient() {
  const { data, mutate } = useSWR<{ events: any[] }>("/api/hr/leave-quota-history", fetcher)
  const [form, setForm] = useState({ employee_id: "", leave_type_id: "", year: String(new Date().getFullYear()), event_type: "Accrual", days: "", reference: "", reason: "" })
  const save = async () => { await fetch("/api/hr/leave-quota-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }); setForm({ ...form, days: "", reference: "", reason: "" }); mutate() }
  return <main className="space-y-6 p-6"><div><h1 className="text-2xl font-semibold">Leave Quota History</h1><p className="text-muted-foreground">Track every leave balance adjustment and usage event.</p></div><Card><CardHeader><CardTitle>Add quota event</CardTitle></CardHeader><CardContent className="grid gap-3 md:grid-cols-4">{[["employee_id","Employee ID"],["leave_type_id","Leave Type ID"],["year","Year"],["days","Days"],["reference","Reference"],["reason","Reason"]].map(([key,label]) => <Input key={key} placeholder={label} value={(form as any)[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />)}<Input placeholder="Event Type" value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value })} /><Button onClick={save}>Add event</Button></CardContent></Card><Card><CardContent className="overflow-x-auto p-0"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-3">Employee</th><th className="p-3">Leave Type</th><th className="p-3">Year</th><th className="p-3">Event</th><th className="p-3">Days</th><th className="p-3">Reference</th><th className="p-3">Reason</th><th className="p-3">Created At</th></tr></thead><tbody>{(data?.events || []).map((event) => <tr key={event.event_id} className="border-b"><td className="p-3">{event.employee_name}</td><td className="p-3">{event.leave_type_id}</td><td className="p-3">{event.year}</td><td className="p-3">{event.event_type}</td><td className="p-3">{event.days}</td><td className="p-3">{event.reference || "—"}</td><td className="p-3">{event.reason}</td><td className="p-3">{event.created_at}</td></tr>)}</tbody></table></CardContent></Card></main>
}
