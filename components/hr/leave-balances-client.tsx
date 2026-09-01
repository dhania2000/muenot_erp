"use client"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Plus, WalletCards } from "lucide-react"
import { useState } from "react"
import { fetcher } from "@/lib/fetcher"

export function LeaveBalancesClient() {
  const { data, mutate } = useSWR<{ balances: any[] }>("/api/hr/leave-balances", fetcher)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ employee_id: "", leave_type_id: "", year: String(new Date().getFullYear()), opening: "", accrued: "", used: "", pending: "", adjusted: "" })
  const balances = data?.balances || []
  async function save(e: React.FormEvent) { e.preventDefault(); await fetch("/api/hr/leave-balances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }); setOpen(false); setForm({ employee_id: "", leave_type_id: "", year: String(new Date().getFullYear()), opening: "", accrued: "", used: "", pending: "", adjusted: "" }); mutate() }
  return <main className="space-y-6 p-6"><div className="flex items-start justify-between"><div><p className="text-sm text-muted-foreground">HR module</p><h1 className="text-3xl font-semibold tracking-tight">Leave Balances</h1><p className="mt-1 text-muted-foreground">Track opening, accrued, used, pending, available, and adjusted leave.</p></div><Dialog open={open} onOpenChange={setOpen}><DialogTrigger><Plus /> Add balance</DialogTrigger><DialogContent><DialogHeader><DialogTitle>Add leave balance</DialogTitle></DialogHeader><form onSubmit={save} className="grid gap-4 sm:grid-cols-2">{[["employee_id","Employee ID"],["leave_type_id","Leave Type ID"],["year","Year"],["opening","Opening"],["accrued","Accrued"],["used","Used"],["pending","Pending"],["adjusted","Adjusted"]].map(([key,label]) => <div className="grid gap-2" key={key}><Label htmlFor={key}>{label}</Label><Input id={key} type={key === "year" ? "number" : key === "employee_id" || key === "leave_type_id" ? "number" : "number"} step="0.5" value={form[key as keyof typeof form]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} required={key === "employee_id" || key === "leave_type_id" || key === "year"} /></div>)}<Button className="sm:col-span-2" type="submit">Save balance</Button></form></DialogContent></Dialog></div><Card><CardHeader><CardTitle className="flex items-center gap-2"><WalletCards /> Current balances</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Leave type</TableHead><TableHead>Year</TableHead><TableHead>Opening</TableHead><TableHead>Accrued</TableHead><TableHead>Used</TableHead><TableHead>Pending</TableHead><TableHead>Available</TableHead><TableHead>Adjusted</TableHead><TableHead>Last updated</TableHead></TableRow></TableHeader><TableBody>{balances.map((row) => <TableRow key={row.balance_id}><TableCell>{row.employee_name || row.employee_id}</TableCell><TableCell>{row.leave_type_id}</TableCell><TableCell>{row.year}</TableCell><TableCell>{row.opening}</TableCell><TableCell>{row.accrued}</TableCell><TableCell>{row.used}</TableCell><TableCell>{row.pending}</TableCell><TableCell className="font-semibold">{row.available}</TableCell><TableCell>{row.adjusted}</TableCell><TableCell>{row.last_updated}</TableCell></TableRow>)}</TableBody></Table>{balances.length === 0 && <p className="py-10 text-center text-muted-foreground">No leave balances yet.</p>}</CardContent></Card></main>
}
