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
import { BookOpen, Plus, Search, Eye, Pencil, Trash2, Users, Briefcase, FolderOpen } from "lucide-react"

type Article = {
  id: number
  heading: string
  description: string
  category_id: number | null
  category_name: string | null
  to_type: "employees" | "clients"
  created_by_name: string | null
  created_at: string
}

type Category = { id: number; name: string }
type ApiResponse = { articles: Article[]; categories: Category[]; canManage: boolean }

const NEW_CATEGORY = "__new__"
const emptyForm = {
  id: 0,
  heading: "",
  description: "",
  to_type: "employees" as "employees" | "clients",
  category_id: "" as string,
  new_category: "",
}

function formatDate(value: string) {
  const d = new Date(value.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function KnowledgeBaseClient() {
  const [q, setQ] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [toFilter, setToFilter] = useState("all")

  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (categoryFilter !== "all") params.set("category", categoryFilter)
  if (toFilter !== "all") params.set("to", toFilter)
  const { data, mutate } = useSWR<ApiResponse>(`/api/knowledge-base?${params.toString()}`, fetcher)

  const articles = data?.articles ?? []
  const categories = data?.categories ?? []
  const canManage = data?.canManage ?? false

  const [form, setForm] = useState(emptyForm)
  const [editorOpen, setEditorOpen] = useState(false)
  const [viewing, setViewing] = useState<Article | null>(null)
  const [saving, setSaving] = useState(false)

  const isEditing = form.id > 0

  const grouped = useMemo(() => {
    const map = new Map<string, Article[]>()
    for (const a of articles) {
      const key = a.category_name ?? "Uncategorized"
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(a)
    }
    return Array.from(map.entries())
  }, [articles])

  const openCreate = () => { setForm(emptyForm); setEditorOpen(true) }
  const openEdit = (a: Article) => {
    setForm({
      id: a.id,
      heading: a.heading,
      description: a.description,
      to_type: a.to_type,
      category_id: a.category_id ? String(a.category_id) : "",
      new_category: "",
    })
    setEditorOpen(true)
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const usingNew = form.category_id === NEW_CATEGORY
    const payload = {
      id: form.id || undefined,
      heading: form.heading,
      description: form.description,
      to_type: form.to_type,
      category_id: usingNew ? undefined : form.category_id || undefined,
      new_category: usingNew ? form.new_category : undefined,
    }
    const res = await fetch("/api/knowledge-base", {
      method: isEditing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    setSaving(false)
    if (res.ok) { setEditorOpen(false); setForm(emptyForm); mutate() }
  }

  const remove = async (id: number) => {
    await fetch(`/api/knowledge-base?id=${id}`, { method: "DELETE" })
    setViewing(null)
    mutate()
  }

  const total = articles.length

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge Base</h1>
          <p className="text-sm text-muted-foreground">Home <span className="px-1">•</span> Knowledge Base</p>
        </div>
        {canManage && (
          <Button onClick={openCreate}>
            <Plus className="mr-2 size-4" /> Add Article
          </Button>
        )}
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Category
          <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v || "all")}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
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

      {/* Articles grouped by category */}
      {total === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card py-20 text-center text-sm text-muted-foreground">
          <BookOpen className="size-10" />
          <p>No articles found.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(([category, items]) => (
            <section key={category} className="overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-3">
                <FolderOpen className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">{category}</h2>
                <span className="text-xs text-muted-foreground">({items.length})</span>
              </div>
              <ul className="divide-y">
                {items.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted/40">
                    <button className="flex-1 text-left" onClick={() => setViewing(a)}>
                      <p className="font-medium hover:underline">{a.heading}</p>
                      <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{a.description}</p>
                    </button>
                    <Badge variant="secondary" className="gap-1.5 font-normal">
                      {a.to_type === "clients" ? <Briefcase className="size-3" /> : <Users className="size-3" />}
                      {a.to_type === "clients" ? "Clients" : "Employees"}
                    </Badge>
                    <span className="hidden text-xs text-muted-foreground sm:inline">{formatDate(a.created_at)}</span>
                    <div className="flex items-center gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => setViewing(a)}>
                        <Eye className="size-3.5" />
                      </Button>
                      {canManage && (
                        <>
                          <Button variant="outline" size="sm" onClick={() => openEdit(a)}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => remove(a.id)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Article" : "Add Article"}</DialogTitle>
            <DialogDescription>Articles appear on the knowledge base of the selected audience.</DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="grid gap-4">
            <div className="grid gap-2">
              <span className="text-sm font-medium">To</span>
              <div className="flex gap-6 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="kb_to_type" checked={form.to_type === "employees"} onChange={() => setForm({ ...form, to_type: "employees" })} />
                  For Employees
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="kb_to_type" checked={form.to_type === "clients"} onChange={() => setForm({ ...form, to_type: "clients" })} />
                  For Clients
                </label>
              </div>
            </div>

            <label className="grid gap-1.5 text-sm font-medium">
              Category
              <Select value={form.category_id || "none"} onValueChange={(v) => setForm({ ...form, category_id: !v || v === "none" ? "" : v })}>
                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Category</SelectItem>
                  {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                  <SelectItem value={NEW_CATEGORY}>+ New Category</SelectItem>
                </SelectContent>
              </Select>
            </label>

            {form.category_id === NEW_CATEGORY && (
              <label className="grid gap-1.5 text-sm font-medium">
                New Category Name
                <Input value={form.new_category} onChange={(e) => setForm({ ...form, new_category: e.target.value })} placeholder="Enter category name" />
              </label>
            )}

            <label className="grid gap-1.5 text-sm font-medium">
              Article Heading
              <Input required value={form.heading} onChange={(e) => setForm({ ...form, heading: e.target.value })} placeholder="Enter article heading" />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Description
              <Textarea required rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Enter article details" />
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
              <div className="flex flex-wrap items-center gap-2">
                {viewing.category_name && (
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <FolderOpen className="size-3" /> {viewing.category_name}
                  </Badge>
                )}
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  {viewing.to_type === "clients" ? <Briefcase className="size-3" /> : <Users className="size-3" />}
                  {viewing.to_type === "clients" ? "Clients" : "Employees"}
                </Badge>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{viewing.description}</p>
              {canManage && (
                <DialogFooter>
                  <Button variant="outline" onClick={() => { const a = viewing; setViewing(null); openEdit(a) }}>
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
