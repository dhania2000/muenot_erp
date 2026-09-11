"use client"
import useSWR from "swr"
import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fetcher } from "@/lib/fetcher"

const CLEARANCE_STATUSES = ["Pending", "In Progress", "Cleared", "Rejected", "Not Applicable"]
const ASSET_STATUSES = ["Issued", "Return Pending", "Returned", "Damaged", "Lost", "Not Applicable"]
const SETTLEMENT_STATUSES = ["Not Started", "Pending Calculation", "Pending Review", "Approved", "Processed", "Completed", "On Hold"]
const KT_STATUSES = ["Not Applicable", "Pending", "In Progress", "Completed"]
const REHIRE_OPTIONS = ["Eligible", "Not Eligible", "Review Required"]
const SETTLEMENT_COMPONENTS = [
  { key: "salary_payable", label: "Salary payable till LWD", sign: 1 },
  { key: "leave_encashment", label: "Leave encashment", sign: 1 },
  { key: "notice_pay", label: "Notice pay", sign: 1 },
  { key: "reimbursements", label: "Reimbursements", sign: 1 },
  { key: "other_payable", label: "Other payable", sign: 1 },
  { key: "notice_recovery", label: "Notice recovery", sign: -1 },
  { key: "loans", label: "Loans", sign: -1 },
  { key: "advances", label: "Advances", sign: -1 },
  { key: "asset_recovery", label: "Asset recovery", sign: -1 },
  { key: "deductions", label: "Other deductions", sign: -1 },
]

function fmtDate(v: any) {
  return v ? String(v).slice(0, 10) : "—"
}
function statusTone(status: string): string {
  const s = (status || "").toLowerCase()
  if (["cleared", "returned", "completed", "approved", "processed", "eligible"].some((x) => s.includes(x)))
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
  if (["rejected", "lost", "cancelled", "withdrawn", "not eligible", "damaged"].some((x) => s.includes(x)))
    return "border-red-500/40 bg-red-500/10 text-red-400"
  if (["not applicable"].some((x) => s.includes(x))) return "border-muted-foreground/30 bg-muted text-muted-foreground"
  return "border-amber-500/40 bg-amber-500/10 text-amber-400"
}

function Info({ label, value }: { label: string; value: any }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium text-foreground">{value ?? "—"}</p>
    </div>
  )
}

export function OffboardingDetail({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const { data, mutate, isLoading } = useSWR<any, Error>(id ? `/api/hr/offboarding/${id}` : null, fetcher)
  const [busy, setBusy] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")

  const c = data?.case
  const canManage = data?.canManage

  async function act(payload: Record<string, any>, successMsg?: string) {
    if (!id) return
    setBusy(true)
    try {
      const res = await fetch(`/api/hr/offboarding/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Action failed")
      if (successMsg) toast.success(successMsg)
      await mutate()
      onChanged()
      return json
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={id != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[96vw] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-3">
            <span>{c ? c.employee_name : "Offboarding case"}</span>
            {c && <span className="font-mono text-xs text-muted-foreground">{c.offboarding_id}</span>}
            {c && <Badge variant="outline" className={statusTone(c.status)}>{c.status}</Badge>}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !c ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading case…</p>
        ) : (
          <Tabs defaultValue="overview" className="w-full">
            <TabsList className="flex w-full flex-wrap justify-start gap-1">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="clearances">Clearances</TabsTrigger>
              <TabsTrigger value="assets">Assets</TabsTrigger>
              <TabsTrigger value="hr">HR Data</TabsTrigger>
              <TabsTrigger value="settlement">Settlement</TabsTrigger>
              <TabsTrigger value="docs">Docs &amp; Letters</TabsTrigger>
              <TabsTrigger value="kt">KT &amp; Interview</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>

            {/* OVERVIEW */}
            <TabsContent value="overview" className="space-y-6 pt-4">
              <section>
                <h3 className="mb-3 text-sm font-semibold text-foreground">Employee context</h3>
                <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-3">
                  <Info label="Employee ID" value={c.employee_code} />
                  <Info label="Department" value={c.department} />
                  <Info label="Designation" value={c.designation} />
                  <Info label="Reporting Manager" value={c.reporting_manager} />
                  <Info label="Joining Date" value={fmtDate(c.joining_date)} />
                  <Info label="Employment Type" value={c.employment_type} />
                  <Info label="Work Mode" value={c.work_mode} />
                  <Info label="Shift" value={c.shift} />
                  <Info label="Current Status" value={<Badge variant="outline" className={statusTone(c.employment_status)}>{c.employment_status}</Badge>} />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link href={`/modules/hr/employees/${c.employee_id}`} className="text-xs text-primary underline-offset-4 hover:underline">Employee profile</Link>
                  <Link href="/modules/hr/attendance" className="text-xs text-primary underline-offset-4 hover:underline">Attendance</Link>
                  <Link href="/modules/hr/leaves" className="text-xs text-primary underline-offset-4 hover:underline">Leaves</Link>
                  <Link href="/modules/hr/employee-documents" className="text-xs text-primary underline-offset-4 hover:underline">Documents</Link>
                </div>
              </section>

              <section className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-3 rounded-lg border border-border bg-card p-4">
                  <h3 className="text-sm font-semibold text-foreground">Exit information</h3>
                  <Info label="Exit Type" value={c.exit_type} />
                  <Info label="Reason" value={c.exit_reason} />
                  <Info label="Remarks" value={c.remarks} />
                </div>
                <div className="space-y-3 rounded-lg border border-border bg-card p-4">
                  <h3 className="text-sm font-semibold text-foreground">Notice period</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <Info label="Notice Date" value={fmtDate(c.notice_date)} />
                    <Info label="Notice Period" value={c.notice_period_days ? `${c.notice_period_days} days` : c.notice_period || "—"} />
                    <Info label="Expected LWD" value={fmtDate(c.expected_last_working_date)} />
                    <Info label="Final / Approved LWD" value={fmtDate(c.last_working_date)} />
                  </div>
                  {canManage && (
                    <EditLwd busy={busy} current={c.last_working_date} onSave={(d) => act({ action: "update_case", last_working_date: d }, "Last working date updated")} />
                  )}
                </div>
              </section>

              <CompletionGate data={data} canManage={canManage} busy={busy} overrideReason={overrideReason} setOverrideReason={setOverrideReason} act={act} />

              {canManage && !["Completed", "Cancelled", "Withdrawn"].includes(c.status) && (
                <CancelBox busy={busy} act={act} />
              )}
            </TabsContent>

            {/* CLEARANCES */}
            <TabsContent value="clearances" className="space-y-3 pt-4">
              {data.clearances.map((cl: any) => (
                <div key={cl.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{cl.department}{cl.is_mandatory ? "" : " (optional)"}</p>
                    <p className="text-xs text-muted-foreground">Owner: {cl.responsible_name || "Unassigned"}{cl.rejection_reason ? ` · Rejected: ${cl.rejection_reason}` : ""}</p>
                  </div>
                  {canManage ? (
                    <Select value={cl.status} onValueChange={(v) => act({ action: "update_clearance", clearance_id: cl.id, status: v }, `${cl.department} → ${v}`)}>
                      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>{CLEARANCE_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="outline" className={statusTone(cl.status)}>{cl.status}</Badge>
                  )}
                </div>
              ))}
              {canManage && <AddRow placeholder="Add clearance department" onAdd={(v) => act({ action: "add_clearance", department: v }, "Clearance added")} busy={busy} />}
            </TabsContent>

            {/* ASSETS */}
            <TabsContent value="assets" className="space-y-3 pt-4">
              <p className="text-xs text-muted-foreground">The ERP has no separate asset master, so company assets are tracked here per exit case.</p>
              {data.assets.length === 0 && <p className="text-sm text-muted-foreground">No assets tracked yet.</p>}
              {data.assets.map((a: any) => (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{a.asset_name}{a.asset_code ? ` · ${a.asset_code}` : ""}</p>
                    <p className="text-xs text-muted-foreground">Assigned {fmtDate(a.assigned_date)}{a.return_date ? ` · Returned ${fmtDate(a.return_date)}` : ""}</p>
                  </div>
                  {canManage ? (
                    <Select value={a.return_status} onValueChange={(v) => act({ action: "update_asset", asset_id: a.id, return_status: v }, `${a.asset_name} → ${v}`)}>
                      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>{ASSET_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="outline" className={statusTone(a.return_status)}>{a.return_status}</Badge>
                  )}
                </div>
              ))}
              {canManage && <AddRow placeholder="Add asset name" onAdd={(v) => act({ action: "add_asset", asset_name: v }, "Asset added")} busy={busy} />}
            </TabsContent>

            {/* HR DATA */}
            <TabsContent value="hr" className="space-y-4 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 rounded-lg border border-border bg-card p-4">
                  <h3 className="text-sm font-semibold text-foreground">Attendance</h3>
                  <Info label="Last attendance" value={fmtDate(data.attendance.lastAttendance)} />
                  {data.attendance.pendingRegularisations > 0 ? (
                    <p className="text-xs text-amber-400">{data.attendance.pendingRegularisations} pending regularisation(s) — <Link href="/modules/hr/attendance-regularisation" className="underline">review</Link></p>
                  ) : (
                    <p className="text-xs text-muted-foreground">No pending regularisations.</p>
                  )}
                </div>
                <div className="space-y-2 rounded-lg border border-border bg-card p-4">
                  <h3 className="text-sm font-semibold text-foreground">Leave</h3>
                  {data.leave.balances.length === 0 && <p className="text-xs text-muted-foreground">No leave balances on record.</p>}
                  {data.leave.balances.map((b: any) => (
                    <p key={b.id} className="text-xs text-muted-foreground">{b.leave_type || `Year ${b.year}`}: {b.remaining ?? b.balance ?? "—"} remaining</p>
                  ))}
                  <p className="text-xs text-muted-foreground">{data.leave.pendingLeaveRequests} pending request(s)</p>
                </div>
                <div className="space-y-2 rounded-lg border border-border bg-card p-4">
                  <h3 className="text-sm font-semibold text-foreground">HR Support</h3>
                  {data.tickets.openTickets > 0 ? (
                    <p className="text-xs text-amber-400">{data.tickets.openTickets} open ticket(s) — <Link href="/modules/hr/support" className="underline">review</Link></p>
                  ) : (
                    <p className="text-xs text-muted-foreground">No open tickets.</p>
                  )}
                </div>
              </div>
            </TabsContent>

            {/* SETTLEMENT */}
            <TabsContent value="settlement" className="pt-4">
              <Settlement c={c} canManage={canManage} busy={busy} act={act} />
            </TabsContent>

            {/* DOCS & LETTERS */}
            <TabsContent value="docs" className="space-y-4 pt-4">
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Letters</h3>
                  <Link href="/modules/hr/generate-letter" className="text-xs text-primary underline-offset-4 hover:underline">Generate letter</Link>
                </div>
                {data.letters.length === 0 && <p className="text-sm text-muted-foreground">No letters generated for this employee.</p>}
                {data.letters.map((l: any) => (
                  <div key={l.id} className="flex items-center justify-between border-b border-border/50 py-2 last:border-0">
                    <span className="text-sm text-foreground">{l.letter_type} <span className="font-mono text-xs text-muted-foreground">{l.letter_id}</span></span>
                    <Badge variant="outline" className={statusTone(l.status)}>{l.status}</Badge>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Employee documents</h3>
                  <Link href="/modules/hr/employee-documents" className="text-xs text-primary underline-offset-4 hover:underline">Open documents</Link>
                </div>
                {data.documents.length === 0 && <p className="text-sm text-muted-foreground">No documents on record.</p>}
                {data.documents.slice(0, 12).map((d: any) => (
                  <div key={d.id} className="flex items-center justify-between border-b border-border/50 py-2 last:border-0">
                    <span className="text-sm text-foreground">{d.doc_type || d.file_name}</span>
                    <Badge variant="outline" className={statusTone(d.status)}>{d.status || "—"}</Badge>
                  </div>
                ))}
              </div>
            </TabsContent>

            {/* KT & INTERVIEW */}
            <TabsContent value="kt" className="space-y-4 pt-4">
              <KnowledgeTransfer c={c} canManage={canManage} busy={busy} act={act} />
              <ExitInterview c={c} canManage={canManage} busy={busy} act={act} />
              <Rehire c={c} canManage={canManage} busy={busy} act={act} />
            </TabsContent>

            {/* TIMELINE */}
            <TabsContent value="timeline" className="space-y-3 pt-4">
              {data.timeline.length === 0 && <p className="text-sm text-muted-foreground">No activity yet.</p>}
              <ol className="relative space-y-4 border-l border-border pl-4">
                {data.timeline.map((t: any) => (
                  <li key={t.id} className="space-y-0.5">
                    <div className="absolute -left-[5px] mt-1.5 h-2 w-2 rounded-full bg-primary" />
                    <p className="text-sm font-medium text-foreground">{t.summary}</p>
                    <p className="text-xs text-muted-foreground">{t.event_type} · {t.actor_name || "System"} · {String(t.created_at).slice(0, 16).replace("T", " ")}</p>
                  </li>
                ))}
              </ol>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}

function EditLwd({ current, onSave, busy }: { current: any; onSave: (d: string) => void; busy: boolean }) {
  const [val, setVal] = useState(current ? String(current).slice(0, 10) : "")
  return (
    <div className="flex items-end gap-2 pt-1">
      <div className="flex-1">
        <Label className="text-xs">Set final LWD</Label>
        <Input type="date" value={val} onChange={(e) => setVal(e.target.value)} />
      </div>
      <Button size="sm" variant="secondary" disabled={busy || !val} onClick={() => onSave(val)}>Save</Button>
    </div>
  )
}

function CompletionGate({ data, canManage, busy, overrideReason, setOverrideReason, act }: any) {
  const c = data.case
  const done = data.checklist.filter((i: any) => i.ok).length
  const blocked = data.checklist.filter((i: any) => i.mandatory && !i.ok)
  const isClosed = ["Completed", "Cancelled", "Withdrawn"].includes(c.status)
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Exit completion</h3>
        <span className="text-sm text-muted-foreground">{done} / {data.checklist.length} completed</span>
      </div>
      <Progress value={(done / data.checklist.length) * 100} />
      <div className="grid gap-2 sm:grid-cols-2">
        {data.checklist.map((i: any) => (
          <div key={i.key} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <span className="text-sm text-foreground">{i.label}{i.mandatory ? "" : " (optional)"}</span>
            <span className={`text-xs ${i.ok ? "text-emerald-400" : "text-amber-400"}`}>{i.ok ? "OK" : i.detail}</span>
          </div>
        ))}
      </div>
      {canManage && !isClosed && (
        <div className="space-y-2 pt-1">
          {blocked.length > 0 && (
            <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-xs text-amber-400">{blocked.length} mandatory item(s) pending. Provide a reason to override and force completion.</p>
              <Input placeholder="Override reason" value={overrideReason} onChange={(e: any) => setOverrideReason(e.target.value)} />
            </div>
          )}
          <Button
            disabled={busy || (blocked.length > 0 && !overrideReason)}
            onClick={() => act({ action: "complete", override: blocked.length > 0, override_reason: overrideReason }, "Offboarding completed")}
          >
            {blocked.length > 0 ? "Override & complete exit" : "Complete exit"}
          </Button>
        </div>
      )}
    </section>
  )
}

function CancelBox({ busy, act }: any) {
  const [reason, setReason] = useState("")
  const [mode, setMode] = useState("cancel")
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Cancel / withdraw</h3>
      <p className="text-xs text-muted-foreground">Restores the employee to their previous status. All history is preserved.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="cancel">Cancel</SelectItem>
            <SelectItem value="withdraw">Withdraw</SelectItem>
          </SelectContent>
        </Select>
        <Input className="flex-1" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button variant="destructive" disabled={busy} onClick={() => act({ action: "cancel", mode, reason }, "Offboarding cancelled")}>Confirm</Button>
      </div>
    </section>
  )
}

function AddRow({ placeholder, onAdd, busy }: { placeholder: string; onAdd: (v: string) => void; busy: boolean }) {
  const [val, setVal] = useState("")
  return (
    <div className="flex gap-2">
      <Input placeholder={placeholder} value={val} onChange={(e) => setVal(e.target.value)} />
      <Button variant="secondary" disabled={busy || !val} onClick={() => { onAdd(val); setVal("") }}>Add</Button>
    </div>
  )
}

function Settlement({ c, canManage, busy, act }: any) {
  const initial = (() => {
    try {
      return typeof c.settlement_breakdown === "string" ? JSON.parse(c.settlement_breakdown || "{}") : c.settlement_breakdown || {}
    } catch {
      return {}
    }
  })()
  const [form, setForm] = useState<Record<string, string>>(
    Object.fromEntries(SETTLEMENT_COMPONENTS.map((k) => [k.key, initial?.[k.key] != null ? String(initial[k.key]) : ""])),
  )
  const [status, setStatus] = useState(c.settlement_status || "Not Started")
  const [notes, setNotes] = useState(c.settlement_notes || "")
  const total = SETTLEMENT_COMPONENTS.reduce((sum, k) => sum + k.sign * (Number(form[k.key]) || 0), 0)

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">Offboarding coordinates the full &amp; final settlement. There is no payroll engine in this ERP, so figures are entered here and the net total is computed automatically.</p>
      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
        {SETTLEMENT_COMPONENTS.map((k) => (
          <div key={k.key} className="space-y-1">
            <Label className="text-xs">{k.label} {k.sign < 0 ? "(−)" : "(+)"}</Label>
            <Input type="number" value={form[k.key]} disabled={!canManage} onChange={(e) => setForm((f) => ({ ...f, [k.key]: e.target.value }))} />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
        <span className="text-sm text-muted-foreground">Net settlement</span>
        <span className="text-lg font-semibold text-foreground">{total.toLocaleString()}</span>
      </div>
      {canManage && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <Label className="text-xs">Settlement status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{SETTLEMENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <Textarea placeholder="Settlement notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <Button
            disabled={busy}
            onClick={() => {
              const breakdown = Object.fromEntries(SETTLEMENT_COMPONENTS.map((k) => [k.key, Number(form[k.key]) || 0]))
              act({ action: "update_settlement", settlement_breakdown: breakdown, settlement_status: status, settlement_notes: notes }, "Settlement saved")
            }}
          >
            Save settlement
          </Button>
          <p className="text-xs text-muted-foreground">Approval is blocked for the case initiator (no self-approval).</p>
        </div>
      )}
      {c.settlement_approved_at && <p className="text-xs text-emerald-400">Approved on {String(c.settlement_approved_at).slice(0, 16).replace("T", " ")}</p>}
    </div>
  )
}

function KnowledgeTransfer({ c, canManage, busy, act }: any) {
  const [status, setStatus] = useState(c.kt_status || "Not Applicable")
  const [to, setTo] = useState(c.kt_handover_to || "")
  const [notes, setNotes] = useState(c.kt_notes || "")
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Knowledge transfer</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={setStatus} disabled={!canManage}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{KT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Handover to</Label>
          <Input value={to} disabled={!canManage} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <Textarea placeholder="Handover notes" value={notes} disabled={!canManage} onChange={(e) => setNotes(e.target.value)} />
      {canManage && <Button variant="secondary" disabled={busy} onClick={() => act({ action: "update_kt", kt_status: status, kt_handover_to: to, kt_notes: notes }, "Knowledge transfer saved")}>Save</Button>}
    </div>
  )
}

function ExitInterview({ c, canManage, busy, act }: any) {
  const data = (() => {
    try {
      return typeof c.exit_interview_data === "string" ? JSON.parse(c.exit_interview_data || "{}") : c.exit_interview_data || {}
    } catch {
      return {}
    }
  })()
  const [form, setForm] = useState<Record<string, string>>({
    primary_reason: data?.primary_reason || "",
    experience: data?.experience || "",
    manager_feedback: data?.manager_feedback || "",
    suggestions: data?.suggestions || "",
  })
  if (!canManage) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Exit interview</h3>
        <p className="text-xs text-muted-foreground">Confidential — restricted to HR.</p>
      </div>
    )
  }
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Exit interview <span className="text-xs font-normal text-muted-foreground">(confidential)</span></h3>
      <Input placeholder="Primary reason for leaving" value={form.primary_reason} onChange={(e) => setForm((f) => ({ ...f, primary_reason: e.target.value }))} />
      <Textarea placeholder="Experience feedback" value={form.experience} onChange={(e) => setForm((f) => ({ ...f, experience: e.target.value }))} />
      <Textarea placeholder="Manager feedback" value={form.manager_feedback} onChange={(e) => setForm((f) => ({ ...f, manager_feedback: e.target.value }))} />
      <Textarea placeholder="Suggestions" value={form.suggestions} onChange={(e) => setForm((f) => ({ ...f, suggestions: e.target.value }))} />
      <Button variant="secondary" disabled={busy} onClick={() => act({ action: "update_exit_interview", exit_interview_status: "Completed", exit_interview_data: form }, "Exit interview saved")}>Save interview</Button>
    </div>
  )
}

function Rehire({ c, canManage, busy, act }: any) {
  const [val, setVal] = useState(c.rehire_eligibility || "")
  const [reason, setReason] = useState(c.rehire_reason || "")
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Rehire eligibility</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48">
          <Select value={val} onValueChange={setVal} disabled={!canManage}>
            <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>{REHIRE_OPTIONS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Input className="flex-1" placeholder="Reason / comments" value={reason} disabled={!canManage} onChange={(e) => setReason(e.target.value)} />
        {canManage && <Button variant="secondary" disabled={busy || !val} onClick={() => act({ action: "update_rehire", rehire_eligibility: val, rehire_reason: reason }, "Rehire eligibility saved")}>Save</Button>}
      </div>
    </div>
  )
}
