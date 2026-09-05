"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Newspaper, Plus, Search, Eye, Pencil, Trash2, Users, Briefcase } from "lucide-react"

type Notice = {
  id: number
  heading: string
  description: string
  to_type: "employees" | "clients"
  department: string | null
  created_by_name: string | null
  created_at: string
}

type ApiResponse = { notices: Notice[]; departments: string[]; canManage: boolean }

const emptyForm = { id: 0, heading: "", description: "", to_type: "employees" as "employees" | "clients", department: "" }

function formatDate(value: string) {
  const d = new Date(value.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

function audienceLabel(n: Pick<Notice, "to_type" | "department">) {
  if (n.to_type === "clients") return "All Clients"
  return n.department ? n.department : "All Employees"
}

export function NoticeBoardClient() {
  const [q, setQ] = useState("")
  const [from, setFrom] = useState("")
  const [toDate, setToDate] = useState("")
  const [toFilter, setToFilter] = useState<string>("all")

  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (from) params.set("from", from)
  if (toDate) params.set("to_date", toDate)
  if (toFilter !== "all") params.set("to", toFilter)
  const { data, mutate } = useSWR<ApiResponse>(`/api/notice-board?${params.toString()}`, fetcher)

  const notices = data?.notices ?? []
  const departments = data?.departments ?? []
  const canManage = data?.canManage ?? false

  const [form, setForm] = useState(emptyForm)
  const [editorOpen, setEditorOpen] = useState(false)
  const [viewing, setViewing] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)

  const isEditing = form.id > 0

  const openCreate = () => { setForm(emptyForm); setEditorOpen(true) }
  const openEdit = (n: Notice) => {
    setForm({ id: n.id, heading: n.heading, description: n.description, to_type: n.to_type, department: n.department ?? "" })
    setEditorOpen(true)
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const payload = {
      id: form.id || undefined,
      heading: form.heading,
      description: form.description,
      to_type: form.to_type,
      department: form.to_type === "employees" && form.department !== "all" ? form.department : null,
    }
    const res = await fetch("/api/notice-board", {
      method: isEditing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    setSaving(false)
    if (res.ok) { setEditorOpen(false); setForm(emptyForm); mutate() }
  }

  const remove = async (id: number) => {
    await fetch(`/api/notice-board?id=${id}`, { method: "DELETE" })
    setViewing(null)
    mutate()
  }

  const total = useMemo(() => notices.length, [notices])

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notice Board</h1>
          <p className="text-sm text-muted-foreground">Home <span className="px-1">•</span> Notice Board</p>
        </div>
        {canManage && (
          <Button onClick={openCreate}>
            <Plus className="mr-2 size-4" /> Add Notice
          </Button>
        )}
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Start Date
          <Input type="date" className="w-44" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          End Date
          <Input type="date" className="w-44" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        {canManage && (
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            To
            <Select value={toFilter} onValueChange={(v) => setToFilter(v || "all")}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="employees">Employees</SelectItem>
                <SelectItem value="clients">Clients</SelectItem>
              </SelectContent>
            </Select>
          </label>
        )}
        <div className="relative ml-auto min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Start typing to search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Notices</h2>
          <span className="text-xs text-muted-foreground">{total} record{total === 1 ? "" : "s"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">Notice</th>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">To</th>
                <th className="px-4 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {notices.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                      <Newspaper className="size-9" />
                      <p>No record found.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                notices.map((n, i) => (
                  <tr key={n.id} className="border-b last:border-b-0 hover:bg-muted/40">
                    <td className="px-4 py-3 text-muted-foreground">{i + 1}</td>
                    <td className="px-4 py-3">
                      <button className="text-left font-medium hover:underline" onClick={() => setViewing(n)}>
                        {n.heading}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(n.created_at)}</td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className="gap-1.5 font-normal">
                        {n.to_type === "clients" ? <Briefcase className="size-3" /> : <Users className="size-3" />}
                        {audienceLabel(n)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => setViewing(n)}>
                          <Eye className="size-3.5" />
                        </Button>
                        {canManage && (
                          <>
                            <Button variant="outline" size="sm" onClick={() => openEdit(n)}>
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => remove(n.id)}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Notice" : "Add Notice"}</DialogTitle>
            <DialogDescription>Notices are shown on the notice board of the selected audience.</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-2">
              <span className="text-sm font-medium">To</span>
              <div className="flex gap-6 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="to_type" checked={form.to_type === "employees"} onChange={() => setForm({ ...form, to_type: "employees" })} />
                  For Employees
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="to_type" checked={form.to_type === "clients"} onChange={() => setForm({ ...form, to_type: "clients" })} />
                  For Clients
                </label>
              </div>
            </div>

            {form.to_type === "employees" && (
              <label className="grid gap-1.5 text-sm font-medium">
                Department
                <Select value={form.department || "all"} onValueChange={(v) => setForm({ ...form, department: v || "all" })}>
                  <SelectTrigger><SelectValue placeholder="All Employees" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Employees</SelectItem>
                    {departments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
            )}

            <label className="grid gap-1.5 text-sm font-medium">
              Notice Heading
              <Input required value={form.heading} onChange={(e) => setForm({ ...form, heading: e.target.value })} placeholder="Enter notice heading" />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Notice Details
              <Textarea required rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Enter notice details" />
            </label>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditorOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* View dialog */}
      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-lg">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="text-pretty">{viewing.heading}</DialogTitle>
                <DialogDescription>
                  {formatDate(viewing.created_at)}
                  {viewing.created_by_name ? ` • Posted by ${viewing.created_by_name}` : ""}
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  {viewing.to_type === "clients" ? <Briefcase className="size-3" /> : <Users className="size-3" />}
                  {audienceLabel(viewing)}
                </Badge>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{viewing.description}</p>
              {canManage && (
                <DialogFooter>
                  <Button variant="outline" onClick={() => { const n = viewing; setViewing(null); openEdit(n) }}>
                    <Pencil className="mr-2 size-3.5" /> Edit
                  </Button>
                  <Button variant="destructive" onClick={() => remove(viewing.id)}>
                    <Trash2 className="mr-2 size-3.5" /> Delete
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  )
}
