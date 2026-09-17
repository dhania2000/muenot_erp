"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts"
import {
  Plus,
  MoreHorizontal,
  ExternalLink,
  Copy,
  Pencil,
  Power,
  Trash2,
  FileInput,
  Users,
  TrendingUp,
  Inbox,
} from "lucide-react"
import { LeadGenFormBuilder } from "@/components/marketing/leadgen-form-builder"

type Dashboard = {
  totals: { forms: number; active_forms: number; submissions: number; leads_created: number; conversion_rate: number }
  trend: { date: string; submissions: number }[]
  topForms: { id: number; name: string; form_code: string; submissions: number; leads_created: number }[]
  bySource: { lead_source: string; submissions: number }[]
  recent: RecentSubmission[]
}
type RecentSubmission = {
  id: number
  submission_code: string
  form_name: string
  full_name: string | null
  email: string | null
  status: string
  created_at: string
}
type FormRow = {
  id: number
  form_code: string
  name: string
  type: string
  status: string
  lead_source: string | null
  public_token: string
  submission_count: number
  lead_count: number
  default_owner_name: string | null
  created_at: string
}
type Submission = {
  id: number
  submission_code: string
  form_id: number
  form_name: string
  full_name: string | null
  email: string | null
  phone: string | null
  company_name: string | null
  status: string
  lead_code: string | null
  contact_code: string | null
  data: Record<string, any>
  created_at: string
}

const statusTone: Record<string, string> = {
  New: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Converted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  Spam: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  Duplicate: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  Archived: "bg-muted text-muted-foreground",
}

function fmtDate(value: string) {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function MarketingLeadGenerationClient() {
  const [tab, setTab] = useState("overview")
  const [builderOpen, setBuilderOpen] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)

  const { data: lookups } = useSWR<any>("/api/marketing/lead-generation/lookups", fetcher)
  const dash = useSWR<Dashboard>("/api/marketing/lead-generation/dashboard", fetcher)
  const forms = useSWR<{ forms: FormRow[] }>("/api/marketing/lead-generation/forms", fetcher)

  function refreshAll() {
    dash.mutate()
    forms.mutate()
  }

  function openCreate() {
    setEditId(null)
    setBuilderOpen(true)
  }
  function openEdit(id: number) {
    setEditId(id)
    setBuilderOpen(true)
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Lead Generation</h1>
          <p className="text-sm text-muted-foreground">
            Capture inbound interest and route it straight into Contacts and the Sales pipeline.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" /> New form
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="forms">Forms</TabsTrigger>
          <TabsTrigger value="submissions">Submissions</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <OverviewTab data={dash.data} onNewForm={openCreate} />
        </TabsContent>

        <TabsContent value="forms" className="space-y-4">
          <FormsTab forms={forms.data?.forms || []} loading={forms.isLoading} onEdit={openEdit} onChanged={refreshAll} />
        </TabsContent>

        <TabsContent value="submissions" className="space-y-4">
          <SubmissionsTab forms={forms.data?.forms || []} onChanged={refreshAll} />
        </TabsContent>
      </Tabs>

      {lookups ? (
        <LeadGenFormBuilder
          open={builderOpen}
          onOpenChange={setBuilderOpen}
          lookups={lookups}
          formId={editId}
          onSaved={refreshAll}
        />
      ) : null}
    </div>
  )
}

function StatCard({ label, value, icon: Icon, hint }: { label: string; value: string; icon: any; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
        <div>
          <p className="text-2xl font-semibold leading-none">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{hint || label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function OverviewTab({ data, onNewForm }: { data?: Dashboard; onNewForm: () => void }) {
  if (!data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="h-24 animate-pulse" />
          </Card>
        ))}
      </div>
    )
  }
  const t = data.totals
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active forms" value={`${t.active_forms}`} hint={`${t.active_forms} active of ${t.forms} forms`} icon={FileInput} />
        <StatCard label="Submissions" value={`${t.submissions}`} hint="Total submissions" icon={Inbox} />
        <StatCard label="Leads created" value={`${t.leads_created}`} hint="Pushed to Sales" icon={Users} />
        <StatCard label="Conversion" value={`${t.conversion_rate}%`} hint="Submissions to leads" icon={TrendingUp} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Submissions (last 30 days)</CardTitle>
          </CardHeader>
          <CardContent>
            {data.trend.some((d) => d.submissions > 0) ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={data.trend} margin={{ left: -20, right: 8, top: 4 }}>
                  <defs>
                    <linearGradient id="subFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={fmtDate} tickLine={false} axisLine={false} fontSize={11} minTickGap={24} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} width={32} />
                  <Tooltip
                    labelFormatter={(l) => fmtDate(String(l))}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Area type="monotone" dataKey="submissions" stroke="var(--color-primary)" fill="url(#subFill)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-16 text-center text-sm text-muted-foreground">No submissions in the last 30 days.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top forms</CardTitle>
            <CardDescription>By submission volume</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.topForms.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">No forms yet.</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={onNewForm}>
                  <Plus className="size-4" /> Create your first form
                </Button>
              </div>
            ) : (
              data.topForms.map((f) => (
                <div key={f.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {f.submissions} subs · {f.leads_created} leads
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent submissions</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Form</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recent.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    No submissions yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.recent.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.full_name || "-"}</TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">{s.form_name}</TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">{s.email || "-"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={statusTone[s.status] || ""}>
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{fmtDate(s.created_at)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}

function publicUrl(token: string) {
  if (typeof window === "undefined") return `/f/${token}`
  return `${window.location.origin}/f/${token}`
}

function FormsTab({
  forms,
  loading,
  onEdit,
  onChanged,
}: {
  forms: FormRow[]
  loading: boolean
  onEdit: (id: number) => void
  onChanged: () => void
}) {
  async function toggleStatus(form: FormRow) {
    const next = form.status === "Published" ? "Paused" : "Published"
    const res = await fetch(`/api/marketing/lead-generation/forms/${form.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    })
    if (res.ok) {
      toast.success(`Form ${next.toLowerCase()}`)
      onChanged()
    } else {
      toast.error("Unable to update status")
    }
  }

  async function remove(form: FormRow) {
    if (!confirm(`Delete "${form.name}"? Submissions are kept but the form will stop accepting new ones.`)) return
    const res = await fetch(`/api/marketing/lead-generation/forms/${form.id}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Form deleted")
      onChanged()
    } else {
      toast.error("Unable to delete form")
    }
  }

  function copyLink(token: string) {
    navigator.clipboard.writeText(publicUrl(token)).then(
      () => toast.success("Public link copied"),
      () => toast.error("Could not copy"),
    )
  }

  if (loading) {
    return <Card><CardContent className="h-48 animate-pulse" /></Card>
  }
  if (forms.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <FileInput className="size-10 text-muted-foreground" />
          <div>
            <p className="font-medium">No lead forms yet</p>
            <p className="text-sm text-muted-foreground">Create a form to start capturing leads from your website.</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Form</TableHead>
              <TableHead className="hidden md:table-cell">Source</TableHead>
              <TableHead className="hidden lg:table-cell">Owner</TableHead>
              <TableHead className="text-center">Subs</TableHead>
              <TableHead className="text-center">Leads</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {forms.map((form) => (
              <TableRow key={form.id}>
                <TableCell>
                  <div className="font-medium">{form.name}</div>
                  <div className="text-xs text-muted-foreground">{form.form_code} · {form.type}</div>
                </TableCell>
                <TableCell className="hidden md:table-cell text-muted-foreground">{form.lead_source || "-"}</TableCell>
                <TableCell className="hidden lg:table-cell text-muted-foreground">{form.default_owner_name || "Unassigned"}</TableCell>
                <TableCell className="text-center">{form.submission_count}</TableCell>
                <TableCell className="text-center">{form.lead_count}</TableCell>
                <TableCell>
                  <Badge variant={form.status === "Published" ? "default" : "secondary"}>{form.status}</Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="size-4" />
                        <span className="sr-only">Actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => window.open(publicUrl(form.public_token), "_blank")}>
                        <ExternalLink className="size-4" /> Open public form
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => copyLink(form.public_token)}>
                        <Copy className="size-4" /> Copy link
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onEdit(form.id)}>
                        <Pencil className="size-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toggleStatus(form)}>
                        <Power className="size-4" /> {form.status === "Published" ? "Pause" : "Activate"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => remove(form)}>
                        <Trash2 className="size-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function SubmissionsTab({ forms, onChanged }: { forms: FormRow[]; onChanged: () => void }) {
  const [formId, setFormId] = useState("all")
  const [status, setStatus] = useState("all")
  const [search, setSearch] = useState("")
  const [active, setActive] = useState<Submission | null>(null)

  const params = new URLSearchParams()
  if (formId !== "all") params.set("form_id", formId)
  if (status !== "all") params.set("status", status)
  const key = `/api/marketing/lead-generation/submissions?${params.toString()}`
  const { data, isLoading, mutate } = useSWR<{ submissions: Submission[] }>(key, fetcher)

  const filtered = useMemo(() => {
    const rows = data?.submissions || []
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (s) =>
        (s.full_name || "").toLowerCase().includes(q) ||
        (s.email || "").toLowerCase().includes(q) ||
        (s.company_name || "").toLowerCase().includes(q),
    )
  }, [data, search])

  async function updateStatus(s: Submission, next: string) {
    const res = await fetch(`/api/marketing/lead-generation/submissions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: s.id, status: next }),
    })
    if (res.ok) {
      toast.success(`Marked as ${next}`)
      mutate()
      onChanged()
      setActive(null)
    } else {
      toast.error("Unable to update submission")
    }
  }

  async function convert(s: Submission) {
    const res = await fetch(`/api/marketing/lead-generation/submissions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: s.id, action: "convert" }),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok) {
      toast.success(body.lead_code ? `Lead ${body.lead_code} created` : "Converted to lead")
      mutate()
      onChanged()
      setActive(null)
    } else {
      toast.error(body.error || "Unable to convert")
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name, email, company"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={formId} onValueChange={setFormId}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All forms" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All forms</SelectItem>
            {forms.map((f) => (
              <SelectItem key={f.id} value={String(f.id)}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            {["all", "New", "Converted", "Spam", "Duplicate", "Archived"].map((s) => (
              <SelectItem key={s} value={s}>
                {s === "all" ? "All statuses" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Form</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead className="hidden lg:table-cell">Company</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    Loading submissions...
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    No submissions match your filters.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((s) => (
                  <TableRow key={s.id} className="cursor-pointer" onClick={() => setActive(s)}>
                    <TableCell className="font-medium">{s.full_name || "-"}</TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">{s.form_name}</TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">{s.email || "-"}</TableCell>
                    <TableCell className="hidden lg:table-cell text-muted-foreground">{s.company_name || "-"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={statusTone[s.status] || ""}>
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{fmtDate(s.created_at)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Sheet open={!!active} onOpenChange={(o) => !o && setActive(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {active ? (
            <>
              <SheetHeader>
                <SheetTitle>{active.full_name || "Submission"}</SheetTitle>
                <SheetDescription>
                  {active.submission_code} · {active.form_name}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-4">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className={statusTone[active.status] || ""}>
                    {active.status}
                  </Badge>
                  {active.lead_code ? <Badge variant="outline">Lead {active.lead_code}</Badge> : null}
                  {active.contact_code ? <Badge variant="outline">Contact {active.contact_code}</Badge> : null}
                </div>

                <div className="space-y-2 rounded-md border p-3 text-sm">
                  {Object.entries(active.data || {}).map(([k, v]) => (
                    <div key={k} className="grid grid-cols-3 gap-2">
                      <span className="text-muted-foreground capitalize">{k.replace(/_/g, " ")}</span>
                      <span className="col-span-2 break-words">{String(v ?? "-")}</span>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap gap-2">
                  {active.status !== "Converted" ? (
                    <Button size="sm" onClick={() => convert(active)}>
                      Convert to lead
                    </Button>
                  ) : null}
                  {active.status !== "Spam" ? (
                    <Button size="sm" variant="outline" onClick={() => updateStatus(active, "Spam")}>
                      Mark spam
                    </Button>
                  ) : null}
                  {active.status !== "Archived" ? (
                    <Button size="sm" variant="outline" onClick={() => updateStatus(active, "Archived")}>
                      Archive
                    </Button>
                  ) : null}
                  {active.status !== "New" ? (
                    <Button size="sm" variant="ghost" onClick={() => updateStatus(active, "New")}>
                      Reset to new
                    </Button>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
