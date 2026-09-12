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
import { ExcelExportButton } from "@/components/excel-export-button"
import { Plus, Search, UserX } from "lucide-react"
import { RotationEmployeeAddDialog } from "./rotation-employee-add-dialog"
import { RotationEmployeeDetailDialog } from "./rotation-employee-detail-dialog"

type View = "all" | "current" | "upcoming" | "historical" | "overdue" | "no-rotation"

const WINDOW_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  current: { label: "Current", variant: "default" },
  upcoming: { label: "Upcoming", variant: "secondary" },
  ended: { label: "Ended", variant: "outline" },
  inactive: { label: "Inactive", variant: "outline" },
}

export function RotationEmployeesClient() {
  const [q, setQ] = useState("")
  const [rotation, setRotation] = useState("all")
  const [department, setDepartment] = useState("all")
  const [status, setStatus] = useState("all")
  const [view, setView] = useState<View>("all")
  const [addOpen, setAddOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const { data: meta } = useSWR<any>("/api/hr/rotation-employees?meta=1", fetcher)

  const isNoRotation = view === "no-rotation"
  const params = new URLSearchParams()
  params.set("view", view)
  if (q) params.set("q", q)
  if (rotation !== "all") params.set("rotation", rotation)
  if (department !== "all") params.set("department", department)
  if (status !== "all") params.set("status", status)

  const { data, mutate, isLoading } = useSWR<any>(`/api/hr/rotation-employees?${params.toString()}`, fetcher)

  const memberships: any[] = data?.memberships || []
  const summary = data?.summary || { current: 0, upcoming: 0, historical: 0, overdue: 0, withoutRotation: 0 }
  const uncovered: any[] = data?.uncovered || []

  const rotations = meta?.rotations || []
  const departments: string[] = meta?.departments || []
  const canManage = true // GET already 403s for non-managers; reaching here implies manage rights.

  const cards = [
    { label: "Current", value: summary.current, tone: "text-emerald-600" },
    { label: "Upcoming", value: summary.upcoming, tone: "text-blue-600" },
    { label: "Historical", value: summary.historical, tone: "text-foreground" },
    { label: "Overdue", value: summary.overdue, tone: summary.overdue ? "text-destructive" : "text-foreground" },
    { label: "Without rotation", value: summary.withoutRotation, tone: summary.withoutRotation ? "text-amber-600" : "text-foreground" },
  ]

  const exportRows = useMemo(
    () =>
      memberships.map((m) => ({
        record_id: m.record_id,
        employee: m.employee_name,
        employee_id: m.employee_code,
        department: m.department,
        rotation: m.rotation_name,
        rotation_id: m.rotation_code,
        start_date: String(m.start_date).slice(0, 10),
        end_date: m.end_date ? String(m.end_date).slice(0, 10) : "",
        current_sequence: m.current_sequence_no ?? "",
        current_shift: m.current_shift_name ?? "",
        status: m.status,
      })),
    [memberships],
  )

  return (
    <main className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">HR / Workforce / Shifts</p>
          <h1 className="text-3xl font-semibold tracking-tight">Shift Rotation Employees</h1>
          <p className="text-muted-foreground">
            The membership layer between employees and rotations — who participates, from when, and what sequence applies today.
          </p>
        </div>
        <div className="flex gap-2">
          <ExcelExportButton
            rows={exportRows}
            filename="shift-rotation-employees"
            columns={[
              { header: "Record ID", value: (r: any) => r.record_id },
              { header: "Employee", value: (r: any) => r.employee },
              { header: "Employee ID", value: (r: any) => r.employee_id },
              { header: "Department", value: (r: any) => r.department },
              { header: "Rotation", value: (r: any) => r.rotation },
              { header: "Rotation ID", value: (r: any) => r.rotation_id },
              { header: "Start", value: (r: any) => r.start_date },
              { header: "End", value: (r: any) => r.end_date },
              { header: "Current sequence", value: (r: any) => r.current_sequence },
              { header: "Current shift", value: (r: any) => r.current_shift },
              { header: "Status", value: (r: any) => r.status },
            ]}
          />
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="mr-2 size-4" />
            Add to rotation
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border bg-card p-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="current">Current</TabsTrigger>
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          <TabsTrigger value="historical">Historical</TabsTrigger>
          <TabsTrigger value="overdue">Overdue</TabsTrigger>
          <TabsTrigger value="no-rotation">Without rotation</TabsTrigger>
        </TabsList>
      </Tabs>

      {isNoRotation ? (
        <UncoveredPanel employees={uncovered} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search record, employee, rotation…"
                className="pl-8"
              />
            </div>
            <Select value={rotation} onValueChange={(v) => setRotation(v ?? "all")}>
              <SelectTrigger className="w-52"><SelectValue placeholder="Rotation" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All rotations</SelectItem>
                {rotations.map((r: any) => (
                  <SelectItem key={r.rotation_id} value={r.rotation_id}>{r.rotation_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={department} onValueChange={(v) => setDepartment(v ?? "all")}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((d) => (<SelectItem key={d} value={d}>{d}</SelectItem>))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => setStatus(v ?? "all")}>
              <SelectTrigger className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="Active">Active</SelectItem>
                <SelectItem value="Inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Record ID</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Rotation</TableHead>
                  <TableHead>Current shift</TableHead>
                  <TableHead>Seq</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                ) : memberships.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No rotation memberships found.</TableCell></TableRow>
                ) : (
                  memberships.map((m) => {
                    const badge = WINDOW_BADGE[m.window] || { label: m.status, variant: "outline" as const }
                    return (
                      <TableRow key={m.record_id} className="cursor-pointer" onClick={() => setDetailId(m.record_id)}>
                        <TableCell className="font-mono text-xs">{m.record_id}</TableCell>
                        <TableCell>
                          <div className="font-medium">{m.employee_name}</div>
                          <div className="text-xs text-muted-foreground">
                            {m.employee_code}{m.department ? ` · ${m.department}` : ""}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{m.rotation_name}</div>
                          <div className="text-xs text-muted-foreground">{m.rotation_code} · {m.cycle_type}</div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {m.current_is_weekly_off ? (
                            <span className="text-muted-foreground">Weekly off</span>
                          ) : (
                            m.current_shift_name || <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{m.current_sequence_no ? `#${m.current_sequence_no}` : "—"}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          {String(m.start_date).slice(0, 10)}
                          <span className="text-muted-foreground"> → {m.end_date ? String(m.end_date).slice(0, 10) : "Onward"}</span>
                        </TableCell>
                        <TableCell><Badge variant={badge.variant}>{badge.label}</Badge></TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <RotationEmployeeAddDialog open={addOpen} onOpenChange={setAddOpen} meta={meta} onCreated={() => mutate()} />
      <RotationEmployeeDetailDialog
        recordId={detailId}
        canManage={canManage}
        onClose={() => setDetailId(null)}
        onChanged={() => mutate()}
      />
    </main>
  )
}

function UncoveredPanel({ employees }: { employees: any[] }) {
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-5 py-3">
        <UserX className="size-4 text-amber-600" />
        <h3 className="text-sm font-semibold">Active employees with no rotation or explicit shift ({employees.length})</h3>
      </div>
      <div className="p-5">
        {employees.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Every active employee resolves a shift through a rotation or an explicit assignment.
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
                <TableRow key={e.employee_pk}>
                  <TableCell className="font-medium">{e.employee_name}</TableCell>
                  <TableCell className="font-mono text-xs">{e.employee_code}</TableCell>
                  <TableCell>{e.department || "—"}</TableCell>
                  <TableCell>{e.designation || "—"}</TableCell>
                  <TableCell className="text-right">
                    <Link href={`/modules/hr/employees/${e.employee_pk}?tab=shift`} className="text-sm text-primary underline">
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
