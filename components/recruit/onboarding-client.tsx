"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ShieldCheck, Trash2, UserCheck } from "lucide-react"
import { PageHeader } from "@/components/recruit/recruit-shared"

type Candidate = {
  application_id: string
  candidate_name: string | null
  job_title: string | null
  email: string | null
  phone: string | null
  offer_status: string | null
  hired_employee_id: string | null
  bgv_total: number
  bgv_cleared: number
  ref_total: number
  ref_cleared: number
  task_total: number
  task_done: number
}

function ProgressBadge({ done, total, label }: { done: number; total: number; label: string }) {
  const complete = total > 0 && done >= total
  return (
    <Badge
      className={
        complete
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : total > 0
            ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            : "bg-muted text-muted-foreground"
      }
    >
      {label} {done}/{total}
    </Badge>
  )
}

export function OnboardingClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ candidates: Candidate[]; migrationPending: boolean }>(
    "/api/recruit/onboarding/candidates",
    fetcher,
  )
  const [active, setActive] = useState<Candidate | null>(null)
  const candidates = data?.candidates ?? []
  const migrationPending = data?.migrationPending

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Onboarding & Verification"
        description="Track background verification, reference checks and pre-joining tasks for candidates who received or accepted an offer."
        icon={ShieldCheck}
      />

      {migrationPending && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          The recruitment integrations migration has not been applied yet. Run{" "}
          <code className="font-mono">database/migrations/2026-10-06-recruit-integrations.sql</code> to enable
          verification tracking.
        </div>
      )}

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Candidate</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Offer</TableHead>
              <TableHead>Verification</TableHead>
              <TableHead className="text-right">Manage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  Loading candidates...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && candidates.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No candidates in onboarding yet. Candidates appear here once an offer is sent or accepted.
                </TableCell>
              </TableRow>
            )}
            {candidates.map((c) => (
              <TableRow key={c.application_id}>
                <TableCell>
                  <div className="font-medium">{c.candidate_name || "—"}</div>
                  <div className="text-xs text-muted-foreground">{c.email || c.application_id}</div>
                </TableCell>
                <TableCell className="text-muted-foreground">{c.job_title || "—"}</TableCell>
                <TableCell>
                  {c.hired_employee_id ? (
                    <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                      Hired · {c.hired_employee_id}
                    </Badge>
                  ) : (
                    <span className="text-sm text-muted-foreground capitalize">{c.offer_status || "—"}</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1.5">
                    <ProgressBadge done={c.bgv_cleared} total={c.bgv_total} label="BGV" />
                    <ProgressBadge done={c.ref_cleared} total={c.ref_total} label="Ref" />
                    <ProgressBadge done={c.task_done} total={c.task_total} label="Tasks" />
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="outline" size="sm" onClick={() => setActive(c)}>
                    <UserCheck data-icon="inline-start" /> Open
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!active} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
          {active && (
            <>
              <DialogHeader>
                <DialogTitle>{active.candidate_name || "Candidate"}</DialogTitle>
                <DialogDescription>
                  {active.job_title || "—"} · {active.application_id}
                </DialogDescription>
              </DialogHeader>
              <Tabs defaultValue="bgv">
                <TabsList>
                  <TabsTrigger value="bgv">Background</TabsTrigger>
                  <TabsTrigger value="ref">References</TabsTrigger>
                  <TabsTrigger value="tasks">Pre-joining</TabsTrigger>
                </TabsList>
                <TabsContent value="bgv">
                  <BgvPanel candidate={active} canManage={canManage} onChange={mutate} />
                </TabsContent>
                <TabsContent value="ref">
                  <ReferencePanel candidate={active} canManage={canManage} onChange={mutate} />
                </TabsContent>
                <TabsContent value="tasks">
                  <TaskPanel candidate={active} canManage={canManage} onChange={mutate} />
                </TabsContent>
              </Tabs>
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  )
}

function statusBadge(status: string) {
  const tone =
    status === "completed" || status === "done"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
      : status === "in_progress"
        ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"
        : "bg-muted text-muted-foreground"
  return <Badge className={tone}>{status.replace("_", " ")}</Badge>
}

function BgvPanel({ candidate, canManage, onChange }: { candidate: Candidate; canManage: boolean; onChange: () => void }) {
  const key = `/api/recruit/onboarding/bgv?application_id=${candidate.application_id}`
  const { data, mutate } = useSWR<{ checks: any[] }>(key, fetcher)
  const [form, setForm] = useState({ check_type: "Identity", agency: "" })
  const checks = data?.checks ?? []

  async function add() {
    const res = await fetch("/api/recruit/onboarding/bgv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, application_id: candidate.application_id, candidate_name: candidate.candidate_name }),
    })
    if (res.ok) { toast.success("Check added"); setForm({ check_type: "Identity", agency: "" }); mutate(); onChange() }
    else toast.error("Unable to add")
  }
  async function setStatus(id: string, check: any, status: string) {
    const res = await fetch(`/api/recruit/onboarding/bgv/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...check, status, completed_at: status === "completed" ? new Date().toISOString().slice(0, 10) : check.completed_at }),
    })
    if (res.ok) { mutate(); onChange() }
  }
  async function remove(id: string) {
    const res = await fetch(`/api/recruit/onboarding/bgv/${id}`, { method: "DELETE" })
    if (res.ok) { mutate(); onChange() }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      {canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
          <div className="grid gap-1.5">
            <Label htmlFor="bgv-type">Check type</Label>
            <Input id="bgv-type" className="w-40" value={form.check_type} onChange={(e) => setForm((f) => ({ ...f, check_type: e.target.value }))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bgv-agency">Agency</Label>
            <Input id="bgv-agency" className="w-48" value={form.agency} onChange={(e) => setForm((f) => ({ ...f, agency: e.target.value }))} />
          </div>
          <Button onClick={add}>Add check</Button>
        </div>
      )}
      <ItemTable
        empty="No background checks yet."
        rows={checks}
        columns={[
          { head: "Type", cell: (r) => r.check_type },
          { head: "Agency", cell: (r) => r.agency || "—" },
          { head: "Status", cell: (r) => statusBadge(r.status) },
        ]}
        canManage={canManage}
        onStatus={(r, s) => setStatus(r.bgv_id, r, s)}
        statuses={["pending", "in_progress", "completed"]}
        onRemove={(r) => remove(r.bgv_id)}
      />
    </div>
  )
}

function ReferencePanel({ candidate, canManage, onChange }: { candidate: Candidate; canManage: boolean; onChange: () => void }) {
  const key = `/api/recruit/onboarding/references?application_id=${candidate.application_id}`
  const { data, mutate } = useSWR<{ checks: any[] }>(key, fetcher)
  const [form, setForm] = useState({ referee_name: "", company: "", contact: "" })
  const checks = data?.checks ?? []

  async function add() {
    const res = await fetch("/api/recruit/onboarding/references", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, application_id: candidate.application_id, candidate_name: candidate.candidate_name }),
    })
    if (res.ok) { toast.success("Reference added"); setForm({ referee_name: "", company: "", contact: "" }); mutate(); onChange() }
    else toast.error("Unable to add")
  }
  async function setStatus(id: string, check: any, status: string) {
    const res = await fetch(`/api/recruit/onboarding/references/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...check, status, checked_at: status === "completed" ? new Date().toISOString().slice(0, 10) : check.checked_at }),
    })
    if (res.ok) { mutate(); onChange() }
  }
  async function remove(id: string) {
    const res = await fetch(`/api/recruit/onboarding/references/${id}`, { method: "DELETE" })
    if (res.ok) { mutate(); onChange() }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      {canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ref-name">Referee</Label>
            <Input id="ref-name" className="w-40" value={form.referee_name} onChange={(e) => setForm((f) => ({ ...f, referee_name: e.target.value }))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ref-company">Company</Label>
            <Input id="ref-company" className="w-40" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ref-contact">Contact</Label>
            <Input id="ref-contact" className="w-40" value={form.contact} onChange={(e) => setForm((f) => ({ ...f, contact: e.target.value }))} />
          </div>
          <Button onClick={add}>Add reference</Button>
        </div>
      )}
      <ItemTable
        empty="No reference checks yet."
        rows={checks}
        columns={[
          { head: "Referee", cell: (r) => r.referee_name || "—" },
          { head: "Company", cell: (r) => r.company || "—" },
          { head: "Contact", cell: (r) => r.contact || "—" },
          { head: "Status", cell: (r) => statusBadge(r.status) },
        ]}
        canManage={canManage}
        onStatus={(r, s) => setStatus(r.reference_id, r, s)}
        statuses={["pending", "in_progress", "completed"]}
        onRemove={(r) => remove(r.reference_id)}
      />
    </div>
  )
}

function TaskPanel({ candidate, canManage, onChange }: { candidate: Candidate; canManage: boolean; onChange: () => void }) {
  const key = `/api/recruit/onboarding/tasks?application_id=${candidate.application_id}`
  const { data, mutate } = useSWR<{ tasks: any[] }>(key, fetcher)
  const [form, setForm] = useState({ task: "", owner: "", due_date: "" })
  const tasks = data?.tasks ?? []

  async function add() {
    if (!form.task.trim()) { toast.error("Task is required"); return }
    const res = await fetch("/api/recruit/onboarding/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, application_id: candidate.application_id, candidate_name: candidate.candidate_name }),
    })
    if (res.ok) { toast.success("Task added"); setForm({ task: "", owner: "", due_date: "" }); mutate(); onChange() }
    else toast.error("Unable to add")
  }
  async function setStatus(id: string, task: any, status: string) {
    const res = await fetch(`/api/recruit/onboarding/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...task, status }),
    })
    if (res.ok) { mutate(); onChange() }
  }
  async function remove(id: string) {
    const res = await fetch(`/api/recruit/onboarding/tasks/${id}`, { method: "DELETE" })
    if (res.ok) { mutate(); onChange() }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      {canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
          <div className="grid gap-1.5">
            <Label htmlFor="task-name">Task</Label>
            <Input id="task-name" className="w-48" value={form.task} onChange={(e) => setForm((f) => ({ ...f, task: e.target.value }))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-owner">Owner</Label>
            <Input id="task-owner" className="w-36" value={form.owner} onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-due">Due</Label>
            <Input id="task-due" type="date" className="w-40" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
          </div>
          <Button onClick={add}>Add task</Button>
        </div>
      )}
      <ItemTable
        empty="No pre-joining tasks yet."
        rows={tasks}
        columns={[
          { head: "Task", cell: (r) => r.task },
          { head: "Owner", cell: (r) => r.owner || "—" },
          { head: "Due", cell: (r) => (r.due_date ? String(r.due_date).slice(0, 10) : "—") },
          { head: "Status", cell: (r) => statusBadge(r.status) },
        ]}
        canManage={canManage}
        onStatus={(r, s) => setStatus(r.task_id, r, s)}
        statuses={["pending", "in_progress", "done"]}
        onRemove={(r) => remove(r.task_id)}
      />
    </div>
  )
}

function ItemTable({
  rows,
  columns,
  empty,
  canManage,
  statuses,
  onStatus,
  onRemove,
}: {
  rows: any[]
  columns: { head: string; cell: (r: any) => React.ReactNode }[]
  empty: string
  canManage: boolean
  statuses: string[]
  onStatus: (r: any, status: string) => void
  onRemove: (r: any) => void
}) {
  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.head}>{c.head}</TableHead>
            ))}
            {canManage && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length + 1} className="py-6 text-center text-sm text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          )}
          {rows.map((r, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell key={c.head}>{c.cell(r)}</TableCell>
              ))}
              {canManage && (
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {statuses.map((s) => (
                      <Button key={s} variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onStatus(r, s)}>
                        {s.replace("_", " ")}
                      </Button>
                    ))}
                    <Button variant="ghost" size="icon-sm" aria-label="Delete" onClick={() => onRemove(r)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
