"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ArrowLeft,
  Users2,
  ShieldCheck,
  FileText,
  CalendarClock,
  Plane,
  Clock,
  LifeBuoy,
  History,
  ScrollText,
  Network,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"
import { PermissionMatrixEditor } from "@/components/hr/permission-matrix-editor"

type LinkedUser = {
  id: number
  email: string
  role: "admin" | "employee"
  status?: string
  mustChangePassword?: boolean
} | null

// Standard employee lifecycle states. Reuses the free-text employment_status
// column already on hr_employees — no new field is introduced.
const LIFECYCLE_STATUSES = [
  "Active",
  "Probation",
  "Notice Period",
  "On Leave",
  "Suspended",
  "Resigned",
  "Terminated",
  "Ex-Employee",
]

function fmtDate(value: unknown) {
  if (!value) return "—"
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString()
}

function fmtDateTime(value: unknown) {
  if (!value) return "—"
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString()
}

function Field({ label, value }: { label: string; value: unknown }) {
  const display = value === null || value === undefined || value === "" ? "—" : String(value)
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{display}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <h3 className="mb-4 text-sm font-semibold">{title}</h3>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</dl>
    </div>
  )
}

function EmptyState({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
      <Icon className="size-6 opacity-50" />
      <p className="text-sm">{label}</p>
    </div>
  )
}

function LoadingBlock() {
  return (
    <div className="flex items-center justify-center py-12 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  )
}

function DataCard({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-5 py-3">
        <Icon className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function StatusBadge({ status }: { status?: string }) {
  return <Badge variant="secondary">{status || "—"}</Badge>
}

// ---------------------------------------------------------------------------
// Related-data tabs (documents / attendance / leaves / shift / support / team)
// All powered by the shared /related endpoint.
// ---------------------------------------------------------------------------
function RelatedTabs({ employeeId, active }: { employeeId: number; active: string }) {
  const relatedTabs = ["documents", "attendance", "leaves", "shift", "support", "team"]
  const { data, isLoading } = useSWR<any>(
    relatedTabs.includes(active) ? `/api/hr/employees/${employeeId}/related` : null,
    fetcher,
  )

  if (isLoading || !data) return <LoadingBlock />

  if (active === "documents") {
    const docs = data.documents || []
    return (
      <DataCard title="Documents" icon={FileText}>
        {docs.length === 0 ? (
          <EmptyState icon={FileText} label="No documents linked to this employee." />
        ) : (
          <ul className="divide-y">
            {docs.map((d: any) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                <div>
                  <p className="text-sm font-medium">{d.document_type || d.file_name || "Document"}</p>
                  <p className="text-xs text-muted-foreground">{d.file_name}</p>
                </div>
                <div className="flex items-center gap-2">
                  {d.verified ? (
                    <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                      Verified
                    </Badge>
                  ) : (
                    <StatusBadge status={d.status || "Pending"} />
                  )}
                  <span className="text-xs text-muted-foreground">{fmtDate(d.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataCard>
    )
  }

  if (active === "attendance") {
    const rows = data.attendance || []
    return (
      <DataCard title="Recent Attendance" icon={CalendarClock}>
        {rows.length === 0 ? (
          <EmptyState icon={CalendarClock} label="No attendance records found." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Clock in</th>
                  <th className="py-2 pr-4 font-medium">Clock out</th>
                  <th className="py-2 font-medium">Hours</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">{fmtDate(r.work_date)}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="py-2 pr-4">{r.clock_in || "—"}</td>
                    <td className="py-2 pr-4">{r.clock_out || "—"}</td>
                    <td className="py-2">{r.working_hours ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataCard>
    )
  }

  if (active === "leaves") {
    const rows = data.leaves || []
    return (
      <DataCard title="Leave Requests" icon={Plane}>
        {rows.length === 0 ? (
          <EmptyState icon={Plane} label="No leave requests found." />
        ) : (
          <ul className="divide-y">
            {rows.map((r: any) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                <div>
                  <p className="text-sm font-medium">
                    {fmtDate(r.from_date)} – {fmtDate(r.to_date)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.request_id ? `${r.request_id} · ` : ""}
                    {r.days ? `${r.days} day(s)` : ""}
                  </p>
                </div>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </DataCard>
    )
  }

  if (active === "shift") {
    const shift = data.shift
    return (
      <DataCard title="Shift Assignment" icon={Clock}>
        {!shift ? (
          <EmptyState icon={Clock} label="No shift assigned." />
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Shift" value={shift.shift_name} />
            <Field label="Start time" value={shift.start_time} />
            <Field label="End time" value={shift.end_time} />
            <Field label="Break (min)" value={shift.break_minutes} />
            <Field label="Working hours" value={shift.working_hours} />
            <Field label="Status" value={shift.status} />
          </dl>
        )}
      </DataCard>
    )
  }

  if (active === "support") {
    const rows = data.tickets || []
    return (
      <DataCard title="HR Support Tickets" icon={LifeBuoy}>
        {rows.length === 0 ? (
          <EmptyState icon={LifeBuoy} label="No support tickets found." />
        ) : (
          <ul className="divide-y">
            {rows.map((r: any) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                <div>
                  <p className="text-sm font-medium">{r.subject || r.support_category || "Ticket"}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.ticket_id ? `${r.ticket_id} · ` : ""}
                    {r.support_category}
                    {r.priority ? ` · ${r.priority}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  <span className="text-xs text-muted-foreground">{fmtDate(r.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataCard>
    )
  }

  // team / hierarchy
  const manager = data.manager
  const reports = data.directReports || []
  return (
    <div className="flex flex-col gap-5">
      <DataCard title="Reporting Manager" icon={Network}>
        {data.reportingManagerName ? (
          manager ? (
            <Link
              href={`/modules/hr/employees/${manager.id}`}
              className="flex items-center justify-between gap-2 rounded-md border p-3 hover:bg-muted/50"
            >
              <div>
                <p className="text-sm font-medium text-primary">{manager.employee_name}</p>
                <p className="text-xs text-muted-foreground">
                  {manager.designation || "—"}
                  {manager.department ? ` · ${manager.department}` : ""}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{manager.employee_id}</span>
            </Link>
          ) : (
            <p className="text-sm">
              {data.reportingManagerName}{" "}
              <span className="text-xs text-muted-foreground">(not linked to an employee record)</span>
            </p>
          )
        ) : (
          <EmptyState icon={Network} label="No reporting manager set." />
        )}
      </DataCard>

      <DataCard title={`Direct Reports (${reports.length})`} icon={Users2}>
        {reports.length === 0 ? (
          <EmptyState icon={Users2} label="No employees report to this person." />
        ) : (
          <ul className="divide-y">
            {reports.map((r: any) => (
              <li key={r.id}>
                <Link
                  href={`/modules/hr/employees/${r.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0 hover:bg-muted/40"
                >
                  <div>
                    <p className="text-sm font-medium text-primary">{r.employee_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.designation || "—"}
                      {r.department ? ` · ${r.department}` : ""}
                    </p>
                  </div>
                  <StatusBadge status={r.employment_status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </DataCard>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline + Audit tabs — both driven by the /events log. Timeline shows all
// lifecycle events; Audit focuses on field-level master-data changes.
// ---------------------------------------------------------------------------
function EventsTab({ employeeId, active, mode }: { employeeId: number; active: string; mode: "timeline" | "audit" }) {
  const { data, isLoading } = useSWR<{ events: any[] }>(
    active === mode ? `/api/hr/employees/${employeeId}/events` : null,
    fetcher,
  )
  if (isLoading || !data) return <LoadingBlock />

  const events = data.events || []
  const rows = mode === "audit" ? events.filter((e) => Array.isArray(e.changes) && e.changes.length > 0) : events

  if (rows.length === 0) {
    return (
      <DataCard title={mode === "audit" ? "Audit History" : "Employee Timeline"} icon={mode === "audit" ? ScrollText : History}>
        <EmptyState
          icon={mode === "audit" ? ScrollText : History}
          label={mode === "audit" ? "No master-data changes recorded yet." : "No activity recorded yet."}
        />
      </DataCard>
    )
  }

  if (mode === "audit") {
    return (
      <DataCard title="Audit History" icon={ScrollText}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Field</th>
                <th className="py-2 pr-4 font-medium">From</th>
                <th className="py-2 pr-4 font-medium">To</th>
                <th className="py-2 pr-4 font-medium">By</th>
                <th className="py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((e) =>
                (e.changes as any[]).map((c, i) => (
                  <tr key={`${e.id}-${i}`} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-4 font-medium">{c.label || c.field}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{c.from === null || c.from === "" ? "—" : String(c.from)}</td>
                    <td className="py-2 pr-4">{c.to === null || c.to === "" ? "—" : String(c.to)}</td>
                    <td className="py-2 pr-4">{e.actor_name || "System"}</td>
                    <td className="py-2 text-muted-foreground">{fmtDateTime(e.created_at)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </DataCard>
    )
  }

  return (
    <DataCard title="Employee Timeline" icon={History}>
      <ol className="relative flex flex-col gap-5 border-l pl-6">
        {rows.map((e) => (
          <li key={e.id} className="relative">
            <span className="absolute -left-[26px] top-1 size-3 rounded-full border-2 border-background bg-primary" />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{e.summary}</p>
              <span className="text-xs text-muted-foreground">{fmtDateTime(e.created_at)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {e.event_type?.replace(/_/g, " ")}
              {e.actor_name ? ` · by ${e.actor_name}` : ""}
            </p>
            {Array.isArray(e.changes) && e.changes.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                {e.changes.slice(0, 6).map((c: any, i: number) => (
                  <li key={i}>
                    {(c.label || c.field)}: {c.from === null || c.from === "" ? "—" : String(c.from)} →{" "}
                    {c.to === null || c.to === "" ? "—" : String(c.to)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </DataCard>
  )
}

export function EmployeeProfile({
  employee,
  linkedUser,
  isAdmin,
  canManage,
  defaultTab,
}: {
  employee: Record<string, any>
  linkedUser: LinkedUser
  isAdmin: boolean
  canManage: boolean
  defaultTab: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tab = searchParams.get("tab") || defaultTab
  const [statusBusy, setStatusBusy] = useState(false)

  function onTabChange(value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value === "overview") params.delete("tab")
    else params.set("tab", value)
    const qs = params.toString()
    router.replace(`/modules/hr/employees/${employee.id}${qs ? `?${qs}` : ""}`, { scroll: false })
  }

  async function changeStatus(status: string) {
    if (!status || status === employee.employment_status) return
    setStatusBusy(true)
    const r = await fetch(`/api/hr/employees/${employee.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    })
    setStatusBusy(false)
    if (r.ok) {
      toast.success(`Status changed to ${status}`)
      router.refresh()
    } else {
      const d = await r.json().catch(() => ({}))
      toast.error(d.error || "Failed to change status")
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-3 -ml-2 text-muted-foreground"
          render={<Link href="/modules/hr/employees" />}
        >
          <ArrowLeft className="size-4" />
          Employees
        </Button>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted">
            {employee.photo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={employee.photo_url || "/placeholder.svg"} alt={employee.employee_name} className="size-full object-cover" />
            ) : (
              <Users2 className="size-7 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-[200px]">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-balance">{employee.employee_name}</h1>
              {employee.archived_at && <Badge variant="outline">Archived</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{employee.employee_id}</span>
              {employee.designation && <span>· {employee.designation}</span>}
              {employee.department && <span>· {employee.department}</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManage ? (
              <Select value={employee.employment_status || "Active"} onValueChange={changeStatus} disabled={statusBusy}>
                <SelectTrigger size="sm" className="w-[160px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {LIFECYCLE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Badge>{employee.employment_status || "Active"}</Badge>
            )}
            {statusBusy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {linkedUser ? (
              <Badge variant="secondary" className="gap-1">
                <ShieldCheck className="size-3" />
                {linkedUser.role === "admin" ? "Admin" : "Has login"}
              </Badge>
            ) : (
              <Badge variant="outline">No login</Badge>
            )}
          </div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={onTabChange} className="w-full">
        <TabsList className="flex h-auto w-full max-w-full justify-start gap-1 overflow-x-auto">
          <TabsTrigger value="overview">Profile</TabsTrigger>
          <TabsTrigger value="employment">Employment</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="attendance">Attendance</TabsTrigger>
          <TabsTrigger value="leaves">Leaves</TabsTrigger>
          <TabsTrigger value="shift">Shift</TabsTrigger>
          <TabsTrigger value="support">HR Support</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="bank">Bank</TabsTrigger>
          {isAdmin && <TabsTrigger value="permissions">Permissions</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-5 flex flex-col gap-5">
          <Section title="Personal">
            <Field label="Full name" value={employee.employee_name} />
            <Field label="Gender" value={employee.gender} />
            <Field label="Date of birth" value={employee.dob} />
            <Field label="Skills" value={employee.skills} />
          </Section>
          <Section title="Contact">
            <Field label="Official email" value={employee.official_email} />
            <Field label="Personal email" value={employee.personal_email} />
            <Field label="Mobile" value={employee.mobile} />
            <Field label="Alternate mobile" value={employee.alternate_mobile} />
            <Field label="Address" value={employee.address} />
            <Field label="City" value={employee.city} />
            <Field label="State" value={employee.state} />
            <Field label="Country" value={employee.country} />
            <Field label="Postal code" value={employee.postal_code} />
          </Section>
          <Section title="Emergency & Relatives">
            <Field label="Emergency contact" value={employee.emergency_contact_name} />
            <Field label="Emergency phone" value={employee.emergency_contact_phone} />
            <Field label="Relation" value={employee.emergency_contact_relation} />
            <Field label="Relative name" value={employee.relative_name} />
            <Field label="Relative relationship" value={employee.relative_relationship} />
            <Field label="Relative phone" value={employee.relative_primary_phone} />
          </Section>
        </TabsContent>

        <TabsContent value="employment" className="mt-5 flex flex-col gap-5">
          <Section title="Role & Reporting">
            <Field label="Department" value={employee.department} />
            <Field label="Designation" value={employee.designation} />
            <Field label="Reporting manager" value={employee.reporting_manager} />
            <Field label="Employment type" value={employee.employment_type} />
            <Field label="Employee grade" value={employee.employee_grade} />
            <Field label="Work mode" value={employee.work_mode} />
            <Field label="Work location" value={employee.work_location} />
            <Field label="Shift" value={employee.shift} />
          </Section>
          <Section title="Dates & Status">
            <Field label="Joining date" value={employee.joining_date} />
            <Field label="Probation end" value={employee.probation_end_date} />
            <Field label="Confirmation date" value={employee.confirmation_date} />
            <Field label="Employment status" value={employee.employment_status} />
            <Field label="Onboarding status" value={employee.onboarding_status} />
            <Field label="Notice period" value={employee.notice_period} />
            <Field label="Exit status" value={employee.exit_status} />
            <Field label="Exit date" value={employee.exit_date} />
          </Section>
        </TabsContent>

        <TabsContent value="documents" className="mt-5">
          <RelatedTabs employeeId={employee.id} active={tab} />
        </TabsContent>
        <TabsContent value="attendance" className="mt-5">
          <RelatedTabs employeeId={employee.id} active={tab} />
        </TabsContent>
        <TabsContent value="leaves" className="mt-5">
          <RelatedTabs employeeId={employee.id} active={tab} />
        </TabsContent>
        <TabsContent value="shift" className="mt-5">
          <RelatedTabs employeeId={employee.id} active={tab} />
        </TabsContent>
        <TabsContent value="support" className="mt-5">
          <RelatedTabs employeeId={employee.id} active={tab} />
        </TabsContent>
        <TabsContent value="team" className="mt-5">
          <RelatedTabs employeeId={employee.id} active={tab} />
        </TabsContent>

        <TabsContent value="timeline" className="mt-5">
          <EventsTab employeeId={employee.id} active={tab} mode="timeline" />
        </TabsContent>
        <TabsContent value="audit" className="mt-5">
          <EventsTab employeeId={employee.id} active={tab} mode="audit" />
        </TabsContent>

        <TabsContent value="bank" className="mt-5 flex flex-col gap-5">
          <Section title="Bank Details">
            <Field label="Account holder" value={employee.bank_account_holder_name} />
            <Field label="Bank name" value={employee.bank_name} />
            <Field label="Account number" value={employee.bank_account_number} />
            <Field label="IFSC code" value={employee.bank_ifsc_code} />
            <Field label="Branch" value={employee.bank_branch} />
            <Field label="Account type" value={employee.bank_account_type} />
            <Field label="SWIFT code" value={employee.bank_swift_code} />
            <Field label="PAN number" value={employee.bank_pan_number} />
            <Field label="UPI ID" value={employee.bank_upi_id} />
          </Section>
        </TabsContent>

        {isAdmin && (
          <TabsContent value="permissions" className="mt-5">
            <PermissionMatrixEditor
              employeeId={employee.id}
              employeeName={employee.employee_name}
              isAdmin={isAdmin}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
