"use client"

import { useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { readExcelFile, mapRow, downloadExcelTemplate } from "@/lib/excel-import"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ArticleEditor } from "@/components/knowledge-base/article-editor"
import { ArticleDetailView } from "@/components/knowledge-base/article-detail"
import { CategoriesManager } from "@/components/knowledge-base/categories-manager"
import {
  type ListResponse, type ArticleDetail, type ArticleRow, type Section, type ContentType,
  SECTIONS, SORT_OPTIONS, STATUS_META, CONTENT_TYPE_META, AUDIENCE_LABELS,
  StatusBadge, TypeBadge, FavoriteStar, formatDate,
} from "@/components/knowledge-base/kb-lib"
import {
  Plus, Search, SlidersHorizontal, Download, Star, Pin, AlertTriangle, Eye, Paperclip,
  BookOpen, ChevronLeft, ChevronRight, Menu, Upload,
} from "lucide-react"
import { cn } from "@/lib/utils"

const STATUS_FILTERS = ["all", ...Object.keys(STATUS_META)] as const
const PAGE_SIZE = 30

export function KnowledgeBaseClient() {
  const [sectionKey, setSectionKey] = useState("articles")
  const [q, setQ] = useState("")
  const [category, setCategory] = useState("all")
  const [status, setStatus] = useState("all")
  const [author, setAuthor] = useState("all")
  const [department, setDepartment] = useState("all")
  const [contentType, setContentType] = useState("all")
  const [sort, setSort] = useState("newest")
  const [toType, setToType] = useState("all")
  const [tag, setTag] = useState("")
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [quick, setQuick] = useState<"all" | "pinned" | "important">("all")
  const [page, setPage] = useState(1)
  const [navOpen, setNavOpen] = useState(false)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ArticleDetail | null>(null)
  const [createType, setCreateType] = useState<ContentType>("article")
  const [detailId, setDetailId] = useState<number | null>(null)

  const section = SECTIONS.find((s) => s.key === sectionKey) ?? SECTIONS[0]
  const isList = section.kind === "list"

  const params = useMemo(() => {
    const p = new URLSearchParams()
    if (q) p.set("q", q)
    if (section.contentType) p.set("section", section.contentType)
    else if (contentType !== "all") p.set("content_type", contentType)
    if (category !== "all") p.set("category", category)
    if (status !== "all") p.set("status", status)
    if (author !== "all") p.set("author", author)
    if (department !== "all") p.set("department", department)
    if (toType !== "all") p.set("to", toType)
    if (tag) p.set("tag", tag)
    if (favoritesOnly) p.set("favorites", "1")
    if (quick === "pinned") p.set("pinned", "1")
    if (quick === "important") p.set("important", "1")
    p.set("sort", sort)
    p.set("page", String(page))
    p.set("pageSize", String(PAGE_SIZE))
    return p.toString()
  }, [q, section.contentType, contentType, category, status, author, department, toType, tag, favoritesOnly, quick, sort, page])

  const { data, mutate } = useSWR<ListResponse>(isList ? `/api/knowledge-base?${params}` : null, fetcher)
  // Meta (authors/departments) for filters — only fetched for managers.
  const { data: filterMeta } = useSWR<{ authors: { id: number; name: string }[]; departments: string[] }>(
    data?.canManage && isList ? "/api/knowledge-base/meta" : null,
    fetcher,
  )

  const articles = data?.articles ?? []
  const categories = data?.categories ?? []
  const canManage = data?.canManage ?? false
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const openCreate = (type: ContentType = "article") => { setEditing(null); setCreateType(type); setEditorOpen(true) }
  const createLabel = section.contentType ? CONTENT_TYPE_META[section.contentType].label : "Article"
  const openEdit = (detail: ArticleDetail) => { setDetailId(null); setEditing(detail); setEditorOpen(true) }
  const resetPageAnd = (fn: () => void) => { fn(); setPage(1) }

  // Row-level Update: fetch the full detail, then open the editor.
  const [rowBusyId, setRowBusyId] = useState<number | null>(null)
  const updateArticle = async (id: number) => {
    setRowBusyId(id)
    try {
      const res = await fetch(`/api/knowledge-base/${id}`)
      const detail = await res.json().catch(() => null)
      if (!res.ok || !detail?.article) { toast.error(detail?.error || "Could not open for editing"); return }
      openEdit(detail as ArticleDetail)
    } catch {
      toast.error("Could not open for editing")
    } finally {
      setRowBusyId(null)
    }
  }

  // Row-level Remove: confirm, then permanently delete.
  const [removeTarget, setRemoveTarget] = useState<ArticleRow | null>(null)
  const confirmRemove = async () => {
    const target = removeTarget
    if (!target) return
    setRowBusyId(target.id)
    try {
      const res = await fetch(`/api/knowledge-base/${target.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete" }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(body.error || "Could not remove"); return }
      toast.success("Removed")
      setRemoveTarget(null)
      mutate()
    } catch {
      toast.error("Could not remove")
    } finally {
      setRowBusyId(null)
    }
  }

  const changeSection = (key: string) => {
    setSectionKey(key)
    setPage(1)
    setNavOpen(false)
    if (key !== "articles") { setContentType("all") }
  }

  const exportCsv = () => {
    const p = new URLSearchParams()
    if (status !== "all") p.set("status", status)
    if (section.contentType) p.set("content_type", section.contentType)
    else if (contentType !== "all") p.set("content_type", contentType)
    window.open(`/api/knowledge-base/export?${p.toString()}`, "_blank")
  }

  const importInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const IMPORT_ALIASES = {
    heading: ["heading", "title", "name", "articletitle"],
    summary: ["summary", "description", "excerpt"],
    content: ["content", "body", "details", "article"],
    content_type: ["contenttype", "type", "category type"],
    category: ["category", "categoryname"],
    subcategory: ["subcategory", "subcategoryname"],
    department: ["department", "dept"],
    tags: ["tags", "keywords", "labels"],
  } as const

  const IMPORT_HEADERS = ["Heading", "Summary", "Content", "Content Type", "Category", "Subcategory", "Department", "Tags"]
  const IMPORT_SAMPLE = ["Leave Policy 2026", "How to apply for leave", "Employees may apply for leave via the HR portal...", "policy", "HR Policies", "Leave", "Human Resources", "leave, hr, policy"]

  const handleImportFile = async (file: File) => {
    setImporting(true)
    try {
      const rawRows = await readExcelFile(file)
      if (!rawRows.length) { toast.error("The file has no data rows"); return }
      const rows = rawRows.map((r) => mapRow(r, IMPORT_ALIASES))
      const res = await fetch("/api/knowledge-base/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, fileName: file.name }),
      })
      const result = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(result.error || "Import failed"); return }
      if (result.imported > 0) {
        toast.success(`Imported ${result.imported} article${result.imported === 1 ? "" : "s"} as draft${result.imported === 1 ? "" : "s"}`)
        mutate()
      }
      if (result.skipped > 0) toast.info(`${result.skipped} skipped (duplicate titles)`)
      if (result.failed > 0) toast.error(`${result.failed} row${result.failed === 1 ? "" : "s"} could not be imported`, { description: result.errors?.[0] })
      if (!result.imported && !result.skipped && !result.failed) toast.info("Nothing to import")
    } catch {
      toast.error("Could not read that file. Use .xlsx, .xls, or .csv.")
    } finally {
      setImporting(false)
    }
  }

  const activeFilterCount =
    (category !== "all" ? 1 : 0) + (status !== "all" ? 1 : 0) + (author !== "all" ? 1 : 0) +
    (department !== "all" ? 1 : 0) + (toType !== "all" ? 1 : 0) + (tag ? 1 : 0) +
    (contentType !== "all" && !section.contentType ? 1 : 0)

  return (
    <main className="flex flex-col gap-0 md:flex-row">
      {/* Section navigation */}
      <SectionNav section={sectionKey} onChange={changeSection} open={navOpen} onOpenChange={setNavOpen} />

      <div className="flex min-w-0 flex-1 flex-col gap-5 p-5 md:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="md:hidden" onClick={() => setNavOpen(true)} aria-label="Open sections">
              <Menu className="size-4" />
            </Button>
            <div>
              <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
                <BookOpen className="size-5 text-primary" /> Knowledge Base
              </h1>
              <p className="text-sm text-muted-foreground">Home <span className="px-1">•</span> {section.label}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canManage && isList && (
              <>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleImportFile(file)
                    e.target.value = ""
                  }}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" disabled={importing}>
                      <Upload className="size-4" /> {importing ? "Importing…" : "Import"}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Bulk import articles</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => importInputRef.current?.click()}>
                      <Upload className="size-4" /> Upload file (.xlsx, .csv)
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => downloadExcelTemplate("knowledge-base-import-template.xlsx", IMPORT_HEADERS, IMPORT_SAMPLE)}>
                      <Download className="size-4" /> Download template
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" onClick={exportCsv}><Download className="size-4" /> Export</Button>
              </>
            )}
            {canManage && (
              <Button onClick={() => openCreate(section.contentType ?? "article")}>
                <Plus className="size-4" /> Add {createLabel}
              </Button>
            )}
          </div>
        </header>

        {section.kind === "categories" && <CategoriesManager />}
        {section.kind === "settings" && <CategoriesManager />}
        {section.kind === "departments" && (
          <DepartmentsView articles={articles} onOpen={setDetailId} />
        )}

        {isList && (
          <>
            {/* Quick access + search */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border bg-card p-0.5">
                {(["all", "pinned", "important"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => resetPageAnd(() => setQuick(k))}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      quick === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {k === "pinned" && <Pin className="size-3.5" />}
                    {k === "important" && <AlertTriangle className="size-3.5" />}
                    {k === "all" ? "All" : k === "pinned" ? "Pinned" : "Important"}
                  </button>
                ))}
              </div>

              <Button
                variant={favoritesOnly ? "default" : "outline"}
                onClick={() => resetPageAnd(() => setFavoritesOnly((v) => !v))}
              >
                <Star className={cn("size-4", favoritesOnly && "fill-current")} /> Favorites
              </Button>

              <div className="relative ml-auto min-w-[200px] flex-1 md:max-w-xs">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search knowledge base" value={q} onChange={(e) => resetPageAnd(() => setQ(e.target.value))} />
              </div>

              <Select value={sort} onValueChange={setSort}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>

              <FiltersMenu
                canManage={canManage}
                showTypeFilter={!section.contentType}
                count={activeFilterCount}
                category={category} setCategory={(v) => resetPageAnd(() => setCategory(v))}
                categories={categories}
                status={status} setStatus={(v) => resetPageAnd(() => setStatus(v))}
                author={author} setAuthor={(v) => resetPageAnd(() => setAuthor(v))}
                authors={filterMeta?.authors ?? []}
                department={department} setDepartment={(v) => resetPageAnd(() => setDepartment(v))}
                departments={filterMeta?.departments ?? []}
                contentType={contentType} setContentType={(v) => resetPageAnd(() => setContentType(v))}
                toType={toType} setToType={(v) => resetPageAnd(() => setToType(v))}
                tag={tag} setTag={(v) => resetPageAnd(() => setTag(v))}
              />
            </div>

            {/* List */}
            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-medium">{section.label}</h2>
                <span className="text-xs text-muted-foreground">{total} record{total === 1 ? "" : "s"}</span>
              </div>

              {articles.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                  <BookOpen className="size-9" />
                  <p>No articles found.</p>
                  {canManage && <Button variant="outline" size="sm" onClick={() => openCreate(section.contentType ?? "article")}><Plus className="size-3.5" /> Add {createLabel}</Button>}
                </div>
              ) : (
                <ul className="divide-y">
                  {articles.map((a) => (
                    <ArticleListItem key={a.id} article={a} canManage={canManage} onOpen={() => setDetailId(a.id)} />
                  ))}
                </ul>
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Page {page} of {totalPages}</span>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    <ChevronLeft className="size-4" /> Prev
                  </Button>
                  <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                    Next <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <ArticleEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        initialContentType={createType}
        onSaved={() => mutate()}
      />
      <ArticleDetailView
        articleId={detailId}
        onClose={() => setDetailId(null)}
        onEdit={openEdit}
        onChanged={() => mutate()}
        onOpenArticle={(id) => setDetailId(id)}
      />
    </main>
  )
}

// ---------------------------------------------------------------------------
// Section navigation (sidebar on desktop, slide-over on mobile)
// ---------------------------------------------------------------------------
function SectionNav({
  section, onChange, open, onOpenChange,
}: { section: string; onChange: (k: string) => void; open: boolean; onOpenChange: (o: boolean) => void }) {
  const list = (
    <nav className="grid gap-0.5">
      {SECTIONS.map((s) => {
        const Icon = s.icon
        const active = s.key === section
        return (
          <button
            key={s.key}
            onClick={() => onChange(s.key)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" /> {s.label}
          </button>
        )
      })}
    </nav>
  )

  return (
    <>
      <aside className="hidden w-56 shrink-0 border-r p-4 md:block">
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Library</p>
        {list}
      </aside>
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
          <div className="absolute left-0 top-0 h-full w-64 border-r bg-background p-4">
            <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Library</p>
            {list}
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Filters dropdown
// ---------------------------------------------------------------------------
function FiltersMenu(props: {
  canManage: boolean; showTypeFilter: boolean; count: number
  category: string; setCategory: (v: string) => void; categories: { id: number; name: string }[]
  status: string; setStatus: (v: string) => void
  author: string; setAuthor: (v: string) => void; authors: { id: number; name: string }[]
  department: string; setDepartment: (v: string) => void; departments: string[]
  contentType: string; setContentType: (v: string) => void
  toType: string; setToType: (v: string) => void
  tag: string; setTag: (v: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <SlidersHorizontal className="size-4" /> Filters
          {props.count > 0 && <Badge className="ml-1 px-1.5">{props.count}</Badge>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Filter articles</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="grid gap-2.5 p-2">
          <FilterSelect label="Category" value={props.category} onChange={props.setCategory}
            options={[{ value: "all", label: "All categories" }, ...props.categories.map((c) => ({ value: String(c.id), label: c.name }))]} />

          {props.showTypeFilter && (
            <FilterSelect label="Type" value={props.contentType} onChange={props.setContentType}
              options={[{ value: "all", label: "All types" }, ...Object.entries(CONTENT_TYPE_META).map(([v, m]) => ({ value: v, label: m.label }))]} />
          )}

          {props.canManage && (
            <>
              <FilterSelect label="Status" value={props.status} onChange={props.setStatus}
                options={STATUS_FILTERS.map((s) => ({ value: s, label: s === "all" ? "All statuses" : STATUS_META[s as keyof typeof STATUS_META].label }))} />
              <FilterSelect label="Channel" value={props.toType} onChange={props.setToType}
                options={[{ value: "all", label: "All" }, { value: "employees", label: "Employees" }, { value: "clients", label: "Clients" }]} />
              <FilterSelect label="Author" value={props.author} onChange={props.setAuthor}
                options={[{ value: "all", label: "All authors" }, ...props.authors.map((a) => ({ value: String(a.id), label: a.name }))]} />
              <FilterSelect label="Department" value={props.department} onChange={props.setDepartment}
                options={[{ value: "all", label: "All departments" }, ...props.departments.map((d) => ({ value: d, label: d }))]} />
            </>
          )}

          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Tag
            <Input className="h-8" value={props.tag} onChange={(e) => props.setTag(e.target.value)} placeholder="Exact tag" />
          </label>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Article list row
// ---------------------------------------------------------------------------
function ArticleListItem({ article: a, canManage, onOpen }: { article: ArticleRow; canManage: boolean; onOpen: () => void }) {
  return (
    <li>
      <button onClick={onOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40">
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          {(() => { const Icon = CONTENT_TYPE_META[a.content_type]?.icon ?? BookOpen; return <Icon className="size-4" /> })()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {!!a.pinned && <Pin className="size-3.5 text-primary" aria-label="Pinned" />}
            {!!a.important && <AlertTriangle className="size-3.5 text-amber-500" aria-label="Important" />}
            <span className="truncate font-medium">{a.heading}</span>
            {!!a.is_favorite && <FavoriteStar active />}
          </div>
          {a.summary && <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{a.summary}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {a.category_name && <span>{a.category_name}</span>}
            <span className="inline-flex items-center gap-1"><Eye className="size-3" /> {a.view_count}</span>
            {a.attachment_count > 0 && <span className="inline-flex items-center gap-1"><Paperclip className="size-3" /> {a.attachment_count}</span>}
            <span>{formatDate(a.updated_at)}</span>
            {canManage && <span>{AUDIENCE_LABELS[a.audience_type]}</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <TypeBadge type={a.content_type} />
          {canManage ? <StatusBadge status={a.status} /> : (!a.is_read && <Badge variant="default" className="font-normal">New</Badge>)}
        </div>
      </button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Departments overview — groups visible articles by department
// ---------------------------------------------------------------------------
function DepartmentsView({ articles, onOpen }: { articles: ArticleRow[]; onOpen: (id: number) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, ArticleRow[]>()
    for (const a of articles) {
      const key = a.department || AUDIENCE_LABELS[a.audience_type] || "General"
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(a)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [articles])

  if (groups.length === 0) {
    return <p className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">No department-specific content yet.</p>
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map(([dept, items]) => (
        <div key={dept} className="rounded-lg border bg-card p-4">
          <h3 className="mb-2 font-medium">{dept}</h3>
          <ul className="grid gap-1">
            {items.slice(0, 6).map((a) => (
              <li key={a.id}>
                <button onClick={() => onOpen(a.id)} className="w-full truncate text-left text-sm text-muted-foreground hover:text-foreground">
                  {a.heading}
                </button>
              </li>
            ))}
          </ul>
          {items.length > 6 && <p className="mt-2 text-xs text-muted-foreground">+{items.length - 6} more</p>}
        </div>
      ))}
    </div>
  )
}
