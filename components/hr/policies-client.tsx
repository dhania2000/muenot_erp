"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"
import { BookMarked, Plus, Loader2, CheckCircle2, AlertCircle, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type PolicyRow = {
  id: number
  code: string | null
  title: string
  category: string | null
  current_version: number
  active: boolean
  ack_count: number
  current_summary: string | null
  acknowledged_current: boolean
}

type PolicyVersion = {
  version: number
  body: string
  summary: string | null
  effective_date: string | null
  published_by_name: string | null
  created_at: string
}

type PolicyDetail = PolicyRow & {
  versions: PolicyVersion[]
  current: PolicyVersion | null
  myAck: { version: number; acknowledged_at: string } | null
}

async function postJSON(url: string, body: unknown, method = "POST", headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "Request failed")
  return data
}

export function PoliciesClient() {
  const { data, isLoading, mutate } = useSWR<PolicyRow[]>("/api/hr/training/policies", fetcher)
  // Manager check: creating a policy is manager-only. We probe courses which
  // shares the same HR grant used for policy management.
  const { data: courses, error: courseErr } = useSWR("/api/hr/training/courses", fetcher, { shouldRetryOnError: false })
  const isManager = !courseErr && Array.isArray(courses)
  const [openId, setOpenId] = useState<number | null>(null)

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
            <BookMarked className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Spec 38</span>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">Policy Acknowledgment</h1>
            <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
              Read company policies and record your acknowledgment. Every publish captures a new version.
            </p>
          </div>
        </div>
        {isManager && <CreatePolicyDialog onCreated={mutate} />}
      </header>

      {isLoading ? (
        <LoadingRows />
      ) : !data || data.length === 0 ? (
        <EmptyCard title="No policies" description="Published policies will appear here for acknowledgment." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((p) => (
            <Card key={p.id} className="flex flex-col">
              <CardHeader className="gap-1">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base leading-tight">{p.title}</CardTitle>
                  {p.acknowledged_current ? (
                    <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300">
                      <CheckCircle2 className="mr-1 size-3" /> Acknowledged
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      <AlertCircle className="mr-1 size-3" /> Pending
                    </Badge>
                  )}
                </div>
                <CardDescription>
                  {p.category || "General"} · v{p.current_version}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto flex flex-col gap-3">
                {p.current_summary && <p className="line-clamp-2 text-sm text-muted-foreground">{p.current_summary}</p>}
                <div className="flex items-center justify-between">
                  {isManager && <span className="text-xs text-muted-foreground">{p.ack_count} acknowledged</span>}
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => setOpenId(p.id)}>
                    {p.acknowledged_current ? "View" : "Read & acknowledge"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {openId != null && (
        <PolicyDialog policyId={openId} isManager={isManager} onClose={() => setOpenId(null)} onChanged={mutate} />
      )}
    </div>
  )
}

function CreatePolicyDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ title: "", category: "", summary: "", body: "", effective_date: "" })
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      await postJSON("/api/hr/training/policies", {
        title: form.title,
        category: form.category || null,
        summary: form.summary || null,
        body: form.body,
        effective_date: form.effective_date || null,
      })
      toast.success("Policy created")
      setOpen(false)
      setForm({ title: "", category: "", summary: "", body: "", effective_date: "" })
      onCreated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="mr-2 size-4" /> New policy</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New policy</DialogTitle>
          <DialogDescription>This publishes version 1 immediately.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
            <Field label="Effective date"><Input type="date" value={form.effective_date} onChange={(e) => setForm({ ...form, effective_date: e.target.value })} /></Field>
          </div>
          <Field label="Summary"><Input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></Field>
          <Field label="Policy body"><Textarea className="min-h-32" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={saving || !form.title.trim() || !form.body.trim()}>
            {saving && <Loader2 className="mr-2 size-4 animate-spin" />} Publish v1
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PolicyDialog({ policyId, isManager, onClose, onChanged }: { policyId: number; isManager: boolean; onClose: () => void; onChanged: () => void }) {
  const { data, isLoading, mutate } = useSWR<PolicyDetail>(`/api/hr/training/policies/${policyId}`, fetcher)
  const [acking, setAcking] = useState(false)

  async function acknowledge() {
    if (!data) return
    setAcking(true)
    try {
      await postJSON(
        `/api/hr/training/policies/${policyId}/acknowledge`,
        { version: data.current_version },
        "POST",
        { "idempotency-key": `ack-${policyId}-${data.current_version}` },
      )
      toast.success("Acknowledgment recorded")
      await mutate()
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAcking(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden p-0">
        {isLoading || !data ? (
          <div className="flex h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <DialogHeader className="border-b p-6 pb-4">
              <DialogTitle>{data.title}</DialogTitle>
              <DialogDescription>{data.category || "General"} · Current version v{data.current_version}</DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-[calc(90vh-8rem)]">
              <Tabs defaultValue="read" className="p-6">
                <TabsList>
                  <TabsTrigger value="read">Read</TabsTrigger>
                  <TabsTrigger value="history">History</TabsTrigger>
                  {isManager && <TabsTrigger value="roster">Roster</TabsTrigger>}
                </TabsList>

                <TabsContent value="read" className="mt-4 flex flex-col gap-4">
                  {data.current?.summary && <p className="text-sm text-muted-foreground">{data.current.summary}</p>}
                  <div className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
                    {data.current?.body || "No content."}
                  </div>
                  <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                    {data.acknowledged_current ? (
                      <span className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                        <CheckCircle2 className="size-4" /> You acknowledged v{data.myAck?.version} on{" "}
                        {data.myAck && new Date(data.myAck.acknowledged_at).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {data.myAck ? `You acknowledged an older version (v${data.myAck.version}). Please re-acknowledge.` : "Not yet acknowledged."}
                      </span>
                    )}
                    <Button size="sm" onClick={acknowledge} disabled={acking || data.acknowledged_current}>
                      {acking && <Loader2 className="mr-2 size-4 animate-spin" />} I acknowledge
                    </Button>
                  </div>
                  {isManager && (
                    <>
                      <Separator />
                      <PublishVersion policyId={policyId} data={data} onPublished={async () => { await mutate(); onChanged() }} />
                    </>
                  )}
                </TabsContent>

                <TabsContent value="history" className="mt-4 flex flex-col gap-3">
                  {data.versions.map((v) => (
                    <div key={v.version} className="rounded-lg border p-3">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-sm font-semibold">Version {v.version}</span>
                        {v.version === data.current_version && <Badge variant="secondary">current</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {v.published_by_name ? `Published by ${v.published_by_name}` : "Published"} · {new Date(v.created_at).toLocaleDateString()}
                        {v.effective_date ? ` · effective ${v.effective_date}` : ""}
                      </p>
                      {v.summary && <p className="mt-1 text-sm">{v.summary}</p>}
                    </div>
                  ))}
                </TabsContent>

                {isManager && (
                  <TabsContent value="roster" className="mt-4">
                    <Roster policyId={policyId} />
                  </TabsContent>
                )}
              </Tabs>
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PublishVersion({ policyId, data, onPublished }: { policyId: number; data: PolicyDetail; onPublished: () => void }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ title: data.title, category: data.category ?? "", summary: "", body: data.current?.body ?? "", effective_date: "" })
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      const res = await postJSON(
        `/api/hr/training/policies/${policyId}`,
        {
          title: form.title,
          category: form.category || null,
          summary: form.summary || null,
          body: form.body,
          effective_date: form.effective_date || null,
        },
        "PATCH",
        { "idempotency-key": `publish-${policyId}-${Date.now()}` },
      )
      toast.success(`Published version ${res.published_version}. Employees notified to re-acknowledge.`)
      setOpen(false)
      onPublished()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4" /> Manage</h3>
      <p className="text-xs text-muted-foreground">Publishing a new version supersedes all prior acknowledgments.</p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" className="self-start">Publish new version</Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Publish v{data.current_version + 1}</DialogTitle>
            <DialogDescription>This supersedes prior acknowledgments and notifies employees.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
              <Field label="Effective date"><Input type="date" value={form.effective_date} onChange={(e) => setForm({ ...form, effective_date: e.target.value })} /></Field>
            </div>
            <Field label="Summary"><Input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></Field>
            <Field label="Policy body"><Textarea className="min-h-32" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
          </div>
          <DialogFooter>
            <Button onClick={submit} disabled={saving || !form.title.trim() || !form.body.trim()}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />} Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Roster({ policyId }: { policyId: number }) {
  const { data } = useSWR<{
    current_version: number
    summary: { current: number; outdated: number; pending: number }
    rows: { employee_id: number; employee_name: string; designation: string | null; latest_version: number | null; acknowledged_at: string | null; state: string }[]
  }>(`/api/hr/training/policies/${policyId}/roster`, fetcher)

  if (!data) return <div className="flex h-24 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 text-xs">
        <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300">{data.summary.current} current</Badge>
        <Badge variant="secondary" className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">{data.summary.outdated} outdated</Badge>
        <Badge variant="secondary">{data.summary.pending} pending</Badge>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Employee</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Acknowledged</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((r) => (
            <TableRow key={r.employee_id}>
              <TableCell className="font-medium">{r.employee_name}</TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">{r.state}</Badge>
              </TableCell>
              <TableCell>{r.latest_version != null ? `v${r.latest_version}` : "—"}</TableCell>
              <TableCell>{r.acknowledged_at ? new Date(r.acknowledged_at).toLocaleDateString() : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function EmptyCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border bg-card p-12 text-center">
      <span className="inline-flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground"><BookMarked className="size-5" /></span>
      <p className="font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-40 animate-pulse rounded-xl border bg-muted/40" />
      ))}
    </div>
  )
}
