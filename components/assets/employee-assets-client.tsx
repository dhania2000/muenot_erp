"use client"

import { useMemo, useState } from "react"
import useSWR, { mutate as globalMutate } from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  Download,
  Laptop,
  Plus,
  RotateCcw,
  Search,
  Undo2,
  Wrench,
} from "lucide-react"

// ── Types mirrored from the API ───────────────────────────────────────────────

type Summary = {
  total_assets: number
  available: number
  assigned: number
  returned: number
  lost: number
  damaged: number
  under_repair: number
  pending_recovery: number
}

type AssignmentRow = {
  assignment_id: string
  finance_fixed_asset_id: string
  asset_name: string | null
  asset_type: string | null
  asset_category: string | null
  employee_id: number
  employee_name: string | null
  employee_ref: string | null
  department: string | null
  assignment_date: string | null
  expected_return_date: string | null
  return_date: string | null
  status: string
  effective_status: string
  pending_recovery: boolean
  net_book_value: number | null
  condition_at_assignment: string | null
  condition_at_return: string | null
  purpose: string | null
  remarks: string | null
}

type ListResponse = { rows: AssignmentRow[]; summary: Summary }

type AssetLookup = {
  asset_id: string
  asset_name: string | null
  asset_category: string | null
  asset_type: string | null
  net_book_value: number
}
type EmployeeLookup = {
  id: number
  employee_id: string | null
  employee_name: string | null
  department: string | null
  designation: string | null
  active: boolean
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

const STATUS_STYLES: Record<string, string> = {
  Assigned: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Returned: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "Under Repair": "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  Lost: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  Damaged: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  Disposed: "bg-muted text-muted-foreground",
}

const fmtDate = (v: string | null) => (v ? v.slice(0, 10) : "—")
const fmtMoney = (v: number | null) =>
  v == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v)

function StatusBadge({ status }: { status: string }) {
  return <Badge variant="secondary" className={STATUS_STYLES[status] ?? ""}>{status}</Badge>
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryCards({ summary }: { summary?: Summary }) {
  const cards = [
    { label: "Total Assets", value: summary?.total_assets, icon: Boxes, tint: "text-foreground" },
    { label: "Available", value: summary?.available, icon: CheckCircle2, tint: "text-emerald-600" },
    { label: "Assigned", value: summary?.assigned, icon: Laptop, tint: "text-blue-600" },
    { label: "Under Repair", value: summary?.under_repair, icon: Wrench, tint: "text-amber-600" },
    { label: "Lost / Damaged", value: (summary?.lost ?? 0) + (summary?.damaged ?? 0), icon: AlertCircle, tint: "text-red-600" },
    { label: "Pending Recovery", value: summary?.pending_recovery, icon: Undo2, tint: "text-orange-600" },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
      {cards.map((c) => {
        const Icon = c.icon
        return (
          <Card key={c.label}>
            <CardContent className="flex flex-col gap-1 p-4">
              <Icon className={`size-4 ${c.tint}`} />
              <span className="text-2xl font-semibold tabular-nums">{c.value ?? "—"}</span>
              <span className="text-xs text-muted-foreground">{c.label}</span>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ── Assign dialog ─────────────────────────────────────────────────────────────

function AssignDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [assetSearch, setAssetSearch] = useState("")
  const [empSearch, setEmpSearch] = useState("")
  const { data } = useSWR<{ assets: AssetLookup[]; employees: EmployeeLookup[] }>(
    open ? `/api/assets/employee-assets/lookups?asset_search=${encodeURIComponent(assetSearch)}&employee_search=${encodeURIComponent(empSearch)}` : null,
    fetcher,
  )
  const [assetId, setAssetId] = useState("")
  const [employeeId, setEmployeeId] = useState("")
  const [assignmentDate, setAssignmentDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [expectedReturn, setExpectedReturn] = useState("")
  const [condition, setCondition] = useState("Good")
  const [purpose, setPurpose] = useState("")
  const [remarks, setRemarks] = useState("")
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setAssetId(""); setEmployeeId(""); setExpectedReturn(""); setPurpose(""); setRemarks(""); setCondition("Good")
  }

  const submit = async () => {
    if (!assetId) return toast.error("Select an asset to assign.")
    if (!employeeId) return toast.error("Select an employee.")
    setSaving(true)
    try {
      const res = await fetch("/api/assets/employee-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          finance_fixed_asset_id: assetId,
          employee_id: Number(employeeId),
          assignment_date: assignmentDate,
          expected_return_date: expectedReturn || null,
          condition_at_assignment: condition,
          purpose: purpose || null,
          remarks: remarks || null,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to assign asset.")
      toast.success("Asset assigned.")
      reset()
      onOpenChange(false)
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign Asset</DialogTitle>
          <DialogDescription>Assign an available company fixed asset to an employee.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Asset</Label>
            <Input placeholder="Search assets…" value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)} />
            <Select value={assetId} onValueChange={setAssetId}>
              <SelectTrigger><SelectValue placeholder="Select an available asset" /></SelectTrigger>
              <SelectContent>
                {(data?.assets ?? []).map((a) => (
                  <SelectItem key={a.asset_id} value={a.asset_id}>
                    {a.asset_id} — {a.asset_name || "Unnamed"} {a.asset_type ? `(${a.asset_type})` : ""}
                  </SelectItem>
                ))}
                {data && data.assets.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">No available assets</div>}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Employee</Label>
            <Input placeholder="Search employees…" value={empSearch} onChange={(e) => setEmpSearch(e.target.value)} />
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger><SelectValue placeholder="Select an employee" /></SelectTrigger>
              <SelectContent>
                {(data?.employees ?? []).map((e) => (
                  <SelectItem key={e.id} value={String(e.id)} disabled={!e.active}>
                    {e.employee_name || "Unnamed"} {e.department ? `· ${e.department}` : ""} {e.active ? "" : "(inactive)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Assignment date</Label>
              <Input type="date" value={assignmentDate} onChange={(e) => setAssignmentDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Expected return</Label>
              <Input type="date" value={expectedReturn} onChange={(e) => setExpectedReturn(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Condition at assignment</Label>
            <Select value={condition} onValueChange={setCondition}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["New", "Good", "Fair", "Damaged"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Purpose</Label>
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Remote work laptop" />
          </div>
          <div className="grid gap-2">
            <Label>Remarks</Label>
            <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Assigning…" : "Assign"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Detail sheet with lifecycle actions ────────────────────────────────────────

type ActionKind = "return" | "reassign" | "mark_lost" | "mark_damaged" | "under_repair" | null

function DetailSheet({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void }) {
  const { data } = useSWR(id ? `/api/assets/employee-assets/${id}` : null, fetcher)
  const [action, setAction] = useState<ActionKind>(null)

  const assignment = data?.assignment
  const active = assignment && ["Assigned", "Under Repair"].includes(assignment.status)

  return (
    <Sheet open={!!id} onOpenChange={(v) => { if (!v) { setAction(null); onClose() } }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{assignment?.finance_fixed_asset_id ?? "Assignment"}</SheetTitle>
          <SheetDescription>{assignment?.asset_name ?? ""}</SheetDescription>
        </SheetHeader>
        {!assignment ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="grid gap-5 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={assignment.effective_status} />
              {assignment.pending_recovery && <Badge variant="destructive">Recovery pending</Badge>}
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Field label="Assignment ID" value={assignment.assignment_id} />
              <Field label="Asset type" value={assignment.asset_type} />
              <Field label="Employee" value={assignment.employee_name} />
              <Field label="Department" value={assignment.department} />
              <Field label="Assigned date" value={fmtDate(assignment.assignment_date)} />
              <Field label="Expected return" value={fmtDate(assignment.expected_return_date)} />
              <Field label="Return date" value={fmtDate(assignment.return_date)} />
              <Field label="Net book value" value={fmtMoney(assignment.net_book_value)} />
              <Field label="Condition (out)" value={assignment.condition_at_assignment} />
              <Field label="Condition (in)" value={assignment.condition_at_return} />
              <Field label="Purpose" value={assignment.purpose} span />
              <Field label="Remarks" value={assignment.remarks} span />
            </dl>

            {active && (
              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button size="sm" variant="outline" onClick={() => setAction("return")}><Undo2 className="mr-1 size-4" />Return</Button>
                <Button size="sm" variant="outline" onClick={() => setAction("reassign")}><RotateCcw className="mr-1 size-4" />Reassign</Button>
                <Button size="sm" variant="outline" onClick={() => setAction("under_repair")}><Wrench className="mr-1 size-4" />Under repair</Button>
                <Button size="sm" variant="outline" onClick={() => setAction("mark_damaged")}>Mark damaged</Button>
                <Button size="sm" variant="outline" onClick={() => setAction("mark_lost")}>Mark lost</Button>
              </div>
            )}

            {action && (
              <ActionForm
                id={assignment.assignment_id}
                action={action}
                onCancel={() => setAction(null)}
                onDone={() => { setAction(null); onDone() }}
              />
            )}

            <div className="border-t pt-4">
              <h3 className="mb-2 text-sm font-medium">Asset history</h3>
              <div className="grid gap-2">
                {(data.history ?? []).map((h: any) => (
                  <div key={h.assignment_id} className="flex items-center justify-between rounded-md border p-2 text-xs">
                    <span>{h.employee_name || "—"}</span>
                    <span className="text-muted-foreground">{fmtDate(h.assignment_date)} → {fmtDate(h.return_date)}</span>
                    <StatusBadge status={h.status} />
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t pt-4">
              <h3 className="mb-2 text-sm font-medium">Audit trail</h3>
              <div className="grid gap-2">
                {(data.audit ?? []).map((a: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="font-medium">{a.action}</span>
                    <span className="text-muted-foreground">{a.user_name || "system"} · {fmtDate(a.created_at)}</span>
                  </div>
                ))}
                {(data.audit ?? []).length === 0 && <span className="text-xs text-muted-foreground">No activity yet.</span>}
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Field({ label, value, span }: { label: string; value: any; span?: boolean }) {
  return (
    <div className={span ? "col-span-2" : ""}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value || "—"}</dd>
    </div>
  )
}

function ActionForm({ id, action, onCancel, onDone }: { id: string; action: Exclude<ActionKind, null>; onCancel: () => void; onDone: () => void }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [condition, setCondition] = useState("Good")
  const [reason, setReason] = useState("")
  const [remarks, setRemarks] = useState("")
  const [employeeId, setEmployeeId] = useState("")
  const [empSearch, setEmpSearch] = useState("")
  const [saving, setSaving] = useState(false)
  const isReassign = action === "reassign"
  const isReturn = action === "return"

  const { data: lookups } = useSWR<{ employees: EmployeeLookup[] }>(
    isReassign ? `/api/assets/employee-assets/lookups?employee_search=${encodeURIComponent(empSearch)}` : null,
    fetcher,
  )

  const titles: Record<string, string> = {
    return: "Record return",
    reassign: "Reassign to another employee",
    mark_lost: "Mark as lost",
    mark_damaged: "Mark as damaged",
    under_repair: "Send for repair",
  }

  const submit = async () => {
    if (isReassign && !employeeId) return toast.error("Select the new employee.")
    setSaving(true)
    try {
      const payload: any = { action }
      if (isReturn) { payload.return_date = date; payload.condition_at_return = condition; payload.return_remarks = remarks }
      else if (isReassign) { payload.employee_id = Number(employeeId); payload.assignment_date = date; payload.return_condition = condition; payload.remarks = remarks }
      else { payload.event_date = date; payload.reason = reason; payload.remarks = remarks }

      const res = await fetch(`/api/assets/employee-assets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Action failed.")
      toast.success("Done.")
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
      <h4 className="text-sm font-medium">{titles[action]}</h4>
      {isReassign && (
        <div className="grid gap-2">
          <Label>New employee</Label>
          <Input placeholder="Search…" value={empSearch} onChange={(e) => setEmpSearch(e.target.value)} />
          <Select value={employeeId} onValueChange={setEmployeeId}>
            <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
            <SelectContent>
              {(lookups?.employees ?? []).map((e) => (
                <SelectItem key={e.id} value={String(e.id)} disabled={!e.active}>
                  {e.employee_name} {e.department ? `· ${e.department}` : ""} {e.active ? "" : "(inactive)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid gap-2">
        <Label>{isReturn ? "Return date" : isReassign ? "Reassign date" : "Event date"}</Label>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      {(isReturn || isReassign) && (
        <div className="grid gap-2">
          <Label>Condition</Label>
          <Select value={condition} onValueChange={setCondition}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{["New", "Good", "Fair", "Damaged"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      )}
      {!isReturn && !isReassign && (
        <div className="grid gap-2">
          <Label>Reason</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <div className="grid gap-2">
        <Label>Remarks</Label>
        <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Confirm"}</Button>
      </div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function EmployeeAssetsClient() {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [pendingRecovery, setPendingRecovery] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const p = new URLSearchParams()
    if (search.trim()) p.set("search", search.trim())
    if (status !== "all") p.set("status", status)
    if (pendingRecovery) p.set("pending_recovery", "1")
    return p.toString()
  }, [search, status, pendingRecovery])

  const listKey = `/api/assets/employee-assets?${queryString}`
  const { data, isLoading } = useSWR<ListResponse>(listKey, fetcher)
  const refresh = () => globalMutate(listKey)

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Employee Assets</h1>
          <span className="text-sm text-muted-foreground">Home • Assets • Employee Assets</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <a href={`/api/assets/employee-assets/export?${queryString}`}><Download className="mr-2 size-4" />Export</a>
          </Button>
          <Button onClick={() => setAssignOpen(true)}><Plus className="mr-2 size-4" />Assign Asset</Button>
        </div>
      </header>

      <SummaryCards summary={data?.summary} />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search asset, employee…" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {["Assigned", "Returned", "Under Repair", "Lost", "Damaged", "Disposed"].map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={pendingRecovery ? "default" : "outline"}
          onClick={() => setPendingRecovery((v) => !v)}
        >
          <Undo2 className="mr-2 size-4" />Recovery pending
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Assignments</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Assigned</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow><TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">Loading…</TableCell></TableRow>
                )}
                {!isLoading && (data?.rows ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">No assignments found.</TableCell></TableRow>
                )}
                {(data?.rows ?? []).map((r) => (
                  <TableRow key={r.assignment_id} className="cursor-pointer" onClick={() => setDetailId(r.assignment_id)}>
                    <TableCell>
                      <div className="font-medium">{r.finance_fixed_asset_id}</div>
                      <div className="text-xs text-muted-foreground">{r.asset_name || "—"}</div>
                    </TableCell>
                    <TableCell>{r.employee_name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{r.department || "—"}</TableCell>
                    <TableCell>{fmtDate(r.assignment_date)}</TableCell>
                    <TableCell>{fmtDate(r.expected_return_date)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={r.effective_status} />
                        {r.pending_recovery && <Badge variant="destructive" className="text-[10px]">recover</Badge>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <AssignDialog open={assignOpen} onOpenChange={setAssignOpen} onDone={refresh} />
      <DetailSheet id={detailId} onClose={() => setDetailId(null)} onDone={() => { refresh(); if (detailId) globalMutate(`/api/assets/employee-assets/${detailId}`) }} />
    </main>
  )
}
