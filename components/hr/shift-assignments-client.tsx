"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertTriangle, Download, Plus, Search, UserX } from "lucide-react"
import { shiftTimeLabel } from "./shift-change-status"
import { ShiftAssignmentCreateDialog } from "./shift-assignment-create-dialog"
import {
  ShiftAssignmentDetailDialog,
  SOURCE_LABELS,
  derivedStateVariant,
} from "./shift-assignment-detail-dialog"

type View = "all" | "active_now" | "upcoming" | "past" | "inactive" | "unassigned" | "conflicts"

const SOURCES = ["MANUAL", "SHIFT_CHANGE_REQUEST", "ROTATION", "IMPORT", "SYSTEM"]

export function ShiftAssignmentsClient() {
  const [q, setQ] = useState("")
  const [employee, setEmployee] = useState("all")
  const [department, setDepartment] = useState("all")
  const [shift, setShift] = useState("all")
  const [changeType, setChangeType] = useState("all")
  const [source, setSource] = useState("all")
  const [scope, setScope] = useState<"all" | "mine">("all")
  const [view, setView] = useState<View>("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const isListView = view !== "unassigned" && view !== "conflicts"

  const params = new URLSearchParams()
  if (q) params.set("q", q)
  if (employee !== "all") params.set("employee_id", employee)
  if (department !== "all") params.set("department", department)
  if (shift !== "all") params.set("shift_id", shift)
  if (changeType !== "all") params.set("change_type", changeType)
  if (source !== "all") params.set("source", source)
  if (scope === "mine") params.set("scope", "mine")
  if (isListView && view !== "all") params.set("state", view)
  if (from) params.set("from", from)
  if (to) params.set("to", to)
  params.set("page", String(page))

  const { data, mutate, isLoading } = useSWR<any>(
    isListView ? `/api/hr/shift-assignments?${params.toString()}` : null,
    fetcher,
  )
  const { data: ctx } = useSWR<any>("/api/hr/shift-assignments/context", fetcher)
  // Lightweight companion feeds for the summary cards + the two special views.
  const { data: unassigned } = useSWR<any>("/api/hr/shift-assignments/unassigned", fetcher)
  const { data: conflicts } = useSWR<any>("/api/hr/shift-assignments/conflicts", fetcher)

  const assignments = data?.assignments || []
  const summary = data?.summary || { activeNow: 0, upcoming: 0, temporary: 0, total: 0 }
  const canManage = data?.canManage ?? ctx?.canManage
  const total = data?.total || 0
  const pageSize = data?.pageSize || 25
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const employees = ctx?.employees || []
  const shifts = ctx?.shifts || []
  const departments = useMemo(() => {
    const set = new Set<string>()
    for (const e of employees) if (e.department) set.add(e.department)
    return Array.from(set).sort()
  }, [employees])

  const cards = [
    { label: "Active now", value: summary.activeNow, tone: "text-emerald-600" },
    { label: "Upcoming", value: summary.upcoming, tone: "text-blue-600" },
    { label: "Temporary", value: summary.temporary, tone: "text-amber-600" },
    { label: "Unassigned", value: unassigned?.count ?? 0, tone: unassigned?.count ? "text-destructive" : "text-foreground" },
    { label: "Conflicts", value: conflicts?.total ?? 0, tone: conflicts?.total ? "text-destructive" : "text-foreground" },
    { label: "Total", value: summary.total, tone: "text-foreground" },
  ]

  const exportParams = new URLSearchParams(params)
  exportParams.delete("page")

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">HR / Workforce</p>
          <h1 className="text-3xl font-semibold tracking-tight">Shift Assignments</h1>
          <p className="text-muted-foreground">
            The authoritative employee-to-shift layer — everything is pulled from the Employees and Shift masters.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/hr/shift-assignments/export?${exportParams.toString()}`}
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </a>
          {canManage && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Assign shift
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <Tabs value={view} onValueChange={(v) => { setView(v as View); setPage(1) }}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="active_now">Current</TabsTrigger>
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          <TabsTrigger value="past">Past</TabsTrigger>
          <TabsTrigger value="inactive">Inactive</TabsTrigger>
          <TabsTrigger value="unassigned">Unassigned</TabsTrigger>
          <TabsTrigger value="conflicts">Conflicts</TabsTrigger>
        </TabsList>
      </Tabs>

      {isListView && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1) }}
                placeholder="Search assignment, employee, shift…"
                className="pl-8"
              />
            </div>
            {canManage && (
              <Select value={employee} onValueChange={(v) => { setEmployee(v ?? "all"); setPage(1) }}>
                <SelectTrigger className="w-48"><SelectValue placeholder="Employee" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All employees</SelectItem>
                  {employees.map((e: any) => (
                    <SelectItem key={e.id} value={String(e.id)}>{e.employee_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {canManage && (
              <Select value={department} onValueChange={(v) => { setDepartment(v ?? "all"); setPage(1) }}>
                <SelectTrigger className="w-44"><SelectValue placeholder="Department" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All departments</SelectItem>
                  {departments.map((d) => (<SelectItem key={d} value={d}>{d}</SelectItem>))}
                </SelectContent>
              </Select>
            )}
            <Select value={shift} onValueChange={(v) => { setShift(v ?? "all"); setPage(1) }}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Shift" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All shifts</SelectItem>
                {shifts.map((s: any) => (<SelectItem key={s.id} value={String(s.id)}>{s.shift_name}</SelectItem>))}
              </SelectContent>
            </Select>
            <Select value={changeType} onValueChange={(v) => { setChangeType(v ?? "all"); setPage(1) }}>
              <SelectTrigger className="w-36"><SelectValue placeholder="Type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="Permanent">Permanent</SelectItem>
                <SelectItem value="Temporary">Temporary</SelectItem>
              </SelectContent>
            </Select>
            <Select value={source} onValueChange={(v) => { setSource(v ?? "all"); setPage(1) }}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Source" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {SOURCES.map((s) => (<SelectItem key={s} value={s}>{SOURCE_LABELS[s]}</SelectItem>))}
              </SelectContent>
            </Select>
            {canManage && (
              <Select value={scope} onValueChange={(v) => { setScope((v as "all" | "mine") ?? "all"); setPage(1) }}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everyone</SelectItem>
                  <SelectItem value="mine">Mine</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="w-40" aria-label="Effective from" />
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="w-40" aria-label="Effective to" />
          </div>

          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Assignment</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Shift</TableHead>
                  <TableHead>Timing</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead>Effective to</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                ) : assignments.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No shift assignments found.</TableCell></TableRow>
                ) : (
                  assignments.map((a: any) => (
                    <TableRow key={a.assignment_id} className="cursor-pointer" onClick={() => setDetailId(a.assignment_id)}>
                      <TableCell className="font-mono text-xs">{a.assignment_id}</TableCell>
                      <TableCell>
                        <div className="font-medium">{a.employee_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {a.employee_code}{a.department ? ` · ${a.department}` : ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{a.shift_name || "—"}</div>
                        <div className="text-xs text-muted-foreground">{a.change_type}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {shiftTimeLabel(a.start_time, a.end_time, Boolean(Number(a.is_overnight)))}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{String(a.effective_from).slice(0, 10)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {a.effective_to ? String(a.effective_to).slice(0, 10) : "Onward"}
                      </TableCell>
                      <TableCell><Badge variant={derivedStateVariant(a.derived_state)}>{a.derived_state}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{SOURCE_LABELS[a.source_type] || a.source_type}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Page {page} of {totalPages} · {total} assignments</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}

      {view === "unassigned" && <UnassignedPanel data={unassigned} />}
      {view === "conflicts" && <ConflictsPanel data={conflicts} />}

      <ShiftAssignmentCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { mutate(); }}
        canOverride={Boolean(data?.canOverride ?? ctx?.canManage)}
      />
      <ShiftAssignmentDetailDialog assignmentId={detailId} onClose={() => setDetailId(null)} onChanged={mutate} />
    </main>
  )
}

function UnassignedPanel({ data }: { data: any }) {
  const employees: any[] = data?.employees || []
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-5 py-3">
        <UserX className="h-4 w-4 text-destructive" />
        <h3 className="text-sm font-semibold">Active employees without an applicable shift ({data?.count ?? 0})</h3>
      </div>
      <div className="p-5">
        {employees.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Every active employee resolves to a shift (directly or via rotation).
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Designation</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">{e.employee_name}</TableCell>
                  <TableCell className="font-mono text-xs">{e.employee_id}</TableCell>
                  <TableCell>{e.department || "—"}</TableCell>
                  <TableCell>{e.designation || "—"}</TableCell>
                  <TableCell className="text-right">
                    <Link href={`/modules/hr/employees/${e.id}?tab=shift`} className="text-sm text-primary underline">
                      Profile
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

function ConflictsPanel({ data }: { data: any }) {
  const overlapping: any[] = data?.overlapping || []
  const inactiveShift: any[] = data?.inactiveShift || []
  const invalidRange: any[] = data?.invalidRange || []
  const empty = !data?.total

  return (
    <div className="space-y-5">
      {empty && (
        <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
          No assignment conflicts or inconsistencies detected.
        </div>
      )}

      {overlapping.length > 0 && (
        <ConflictCard title={`Overlapping active assignments (${overlapping.length})`}>
          {overlapping.map((r) => (
            <li key={`${r.a_id}-${r.b_id}`} className="py-2 text-sm">
              <span className="font-medium">{r.employee_name}</span>{" "}
              <span className="text-xs text-muted-foreground">({r.employee_code})</span>:{" "}
              <span className="font-mono text-xs">{r.a_id}</span> {r.a_shift} vs{" "}
              <span className="font-mono text-xs">{r.b_id}</span> {r.b_shift}
            </li>
          ))}
        </ConflictCard>
      )}

      {inactiveShift.length > 0 && (
        <ConflictCard title={`Active assignment to an inactive shift (${inactiveShift.length})`}>
          {inactiveShift.map((r) => (
            <li key={r.assignment_id} className="py-2 text-sm">
              <span className="font-medium">{r.employee_name}</span>{" "}
              <span className="font-mono text-xs">{r.assignment_id}</span> · {r.shift_name}
            </li>
          ))}
        </ConflictCard>
      )}

      {invalidRange.length > 0 && (
        <ConflictCard title={`Invalid date ranges (${invalidRange.length})`}>
          {invalidRange.map((r) => (
            <li key={r.assignment_id} className="py-2 text-sm">
              <span className="font-medium">{r.employee_name}</span>{" "}
              <span className="font-mono text-xs">{r.assignment_id}</span> ·{" "}
              {String(r.effective_from).slice(0, 10)} → {r.effective_to ? String(r.effective_to).slice(0, 10) : "—"}
            </li>
          ))}
        </ConflictCard>
      )}
    </div>
  )
}

function ConflictCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-5 py-3">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <ul className="divide-y px-5 py-2">{children}</ul>
    </div>
  )
}
