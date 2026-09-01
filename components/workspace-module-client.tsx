"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { CalendarDays, ChevronLeft, ChevronRight, Download, FileText, Link2, List, MapPin, Newspaper, Package, Plus, Search, Settings2, Ticket, Upload, Users } from "lucide-react"

type Props = { slug: string; name: string; description: string }
type Config = { icon: typeof CalendarDays; accent: string; fields: string[]; columns: string[] }

const configs: Record<string, Config> = {
  calendar: { icon: CalendarDays, accent: "Schedule", fields: ["Event title", "Start date", "End date"], columns: ["Type", "Calendar"] },
  events: { icon: Ticket, accent: "Company events", fields: ["Event name", "Date", "Location"], columns: ["Event", "Employee", "Client", "Status"] },
  "notice-board": { icon: Newspaper, accent: "Announcements", fields: ["Notice heading", "Publish date", "Department", "Notice details"], columns: ["Notice", "Date", "To", "Action"] },
  "knowledge-base": { icon: FileText, accent: "Company knowledge", fields: ["Article heading", "Category", "Description"], columns: ["#", "Article heading", "Article category", "To", "Action"] },
  assets: { icon: Package, accent: "Asset register", fields: ["Asset name", "Asset type", "Serial number", "Value", "Location", "Description"], columns: ["Id", "Asset picture", "Asset name", "Lent To", "Status", "Date", "Action"] },
}

const samples = {
  assets: ["Suscipit Non", "Neque Praesentium", "Occaecati Beatae", "Non Autem", "Exercitationem Et"],
  "notice-board": ["Annual leave policy update", "Quarterly town hall announcement", "Office maintenance notice", "Welcome to the team"],
  "knowledge-base": ["Getting started with WorkSuite", "Expense policy and approvals", "Project handover checklist"],
  events: ["Team planning session", "Client kickoff", "Quarterly review"],
}

function Toolbar({ slug, query, setQuery }: { slug: string; query: string; setQuery: (v: string) => void }) {
  return <div className="erp-filterbar">
    {slug === "assets" && <><span>Asset Type</span><select aria-label="Asset type"><option>All</option><option>Hardware</option><option>Software</option></select><span>Employees</span><select aria-label="Employees"><option>All</option></select><span>Status</span><select aria-label="Status"><option>All</option><option>Available</option><option>Damaged</option></select></>}
    {slug === "events" && <><span>Employee</span><select aria-label="Employee"><option>All</option></select><span>Client</span><select aria-label="Client"><option>All</option></select><span>Status</span><select aria-label="Status"><option>All</option><option>Pending</option></select></>}
    {slug === "calendar" && <><span>Type</span><select aria-label="Type"><option>All</option><option>Meeting</option><option>Leave</option></select></>}
    {slug === "notice-board" && <><span>Duration</span><select aria-label="Duration"><option>Start Date To End Date</option></select></>}
    <div className="erp-search"><Search className="size-4" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Start typing to search" /></div>
  </div>
}

function Form({ config, name, onClose }: { config: Config; name: string; onClose: () => void }) {
  return <Card className="erp-form"><CardHeader><CardTitle>{name === "Assets" ? "Add Asset Info" : name === "Notice Board" ? "Notice Details" : name === "Knowledge Base" ? "Article Details" : `Add ${name}`}</CardTitle></CardHeader><CardContent className="grid gap-6 sm:grid-cols-2">
    {(name === "Notice Board" || name === "Knowledge Base") && <div className="sm:col-span-2 flex gap-6 text-sm"><label><input type="radio" defaultChecked name="audience" /> For Employees</label><label><input type="radio" name="audience" /> For Clients</label></div>}
    {config.fields.map((field) => <label key={field} className="grid gap-2 text-sm font-medium">{field}<Input placeholder={field === "Description" || field === "Notice details" ? `Enter ${field.toLowerCase()}` : field} /></label>)}
    {name === "Assets" && <div className="sm:col-span-2 flex flex-wrap gap-5 text-sm"><span>Status</span>{["Available", "Non Functional", "Lost", "Damaged", "Under Maintenance"].map((status, i) => <label key={status}><input type="radio" name="asset-status" defaultChecked={i === 0} /> {status}</label>)}</div>}
    {(name === "Assets" || name === "Notice Board" || name === "Knowledge Base") && <label className="sm:col-span-2 grid gap-2 text-sm font-medium">{name === "Assets" ? "Upload picture" : "Add File"}<div className="erp-upload"><Upload className="size-7" /> Choose a file</div></label>}
    <div className="sm:col-span-2 flex gap-3 border-t pt-5"><Button><span className="mr-2">✓</span>Save</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
  </CardContent></Card>
}

function CalendarView() {
  const [month, setMonth] = useState(new Date(2026, 8, 1))
  const days = Array.from({ length: 35 }, (_, i) => i - 1)
  return <Card className="erp-calendar"><CardContent className="p-7"><div className="flex items-center justify-between gap-4"><div className="flex gap-2"><Button variant="outline" size="icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft /></Button><Button variant="outline" size="icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight /></Button><Button variant="outline">today</Button></div><strong>{month.toLocaleString("en-US", { month: "long", year: "numeric" })}</strong><div className="hidden sm:flex"><Button className="rounded-r-none">month</Button><Button variant="outline" className="rounded-none">week</Button><Button variant="outline" className="rounded-l-none">list</Button></div></div><div className="erp-calendar-grid mt-8">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div className="erp-dayhead" key={day}>{day}</div>)}{days.map((day, i) => <div className="erp-day" key={i}><span>{day > 0 && day <= 30 ? day : ""}</span>{day === 1 && <b>● 3:00 AM Necessitati</b>}</div>)}</div></CardContent></Card>
}

export function WorkspaceModuleClient({ slug, name, description }: Props) {
  const config = configs[slug] ?? { icon: Users, accent: "Workspace", fields: ["Title", "Status", "Description"], columns: ["Title", "Status", "Action"] }
  const Icon = config.icon
  const [query, setQuery] = useState("")
  const [showForm, setShowForm] = useState(false)
  const rows = useMemo(() => (samples[slug as keyof typeof samples] ?? []).filter((v) => v.toLowerCase().includes(query.toLowerCase())), [slug, query])
  return <main className="erp-page"><header className="erp-pagehead"><div><h1>{name}</h1><span>Home • {name}</span></div><div className="erp-utilities"><Search /><FileText /><span>◷</span><Plus /><span>♟</span></div></header>
    <Toolbar slug={slug} query={query} setQuery={setQuery} />
    {slug === "calendar" ? <CalendarView /> : <><div className="erp-actions"><Button onClick={() => setShowForm(!showForm)}><Plus className="mr-2 size-4" />{slug === "assets" ? "Add New Asset" : slug === "notice-board" ? "Add New Notice" : slug === "knowledge-base" ? "Add New Article" : "Add Event"}</Button><Button variant="outline"><Download className="mr-2 size-4" />Export</Button>{slug === "assets" && <Button variant="outline" className="ml-auto"><Settings2 /></Button>}</div>{showForm && <Form config={config} name={name} onClose={() => setShowForm(false)} />}<Card className="erp-table-card"><CardHeader><CardTitle>{slug === "knowledge-base" ? "Knowledge Base" : name}</CardTitle></CardHeader><CardContent><div className="erp-table-head">{config.columns.map((c) => <span key={c}>{c}</span>)}</div>{rows.length ? rows.map((row, i) => <div className="erp-table-row" key={row}>{config.columns.map((column, j) => <span key={column}>{j === 0 ? row : j === config.columns.length - 1 ? <Button variant="outline" size="sm">{slug === "notice-board" || slug === "knowledge-base" ? "View" : "⋮"}</Button> : j === 1 && slug === "assets" ? "--" : j === 2 && slug === "assets" ? "-" : j === 3 && slug === "assets" ? <em className="erp-status"><i />Available</em> : j === 1 ? "08-09-2026" : "Employee"}</span>)}</div>) : <div className="erp-empty"><Icon /><p>{query ? `No records match “${query}”.` : "- No record found. -"}</p></div>}</CardContent></Card></>}
  </main>
}
