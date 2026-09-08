"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Users2, ShieldCheck } from "lucide-react"
import { PermissionMatrixEditor } from "@/components/hr/permission-matrix-editor"

type LinkedUser = {
  id: number
  email: string
  role: "admin" | "employee"
  status?: string
  mustChangePassword?: boolean
} | null

function Field({ label, value }: { label: string; value: unknown }) {
  const display = value === null || value === undefined || value === "" ? "—" : String(value)
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{display}</dd>
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

export function EmployeeProfile({
  employee,
  linkedUser,
  isAdmin,
  defaultTab,
}: {
  employee: Record<string, any>
  linkedUser: LinkedUser
  isAdmin: boolean
  defaultTab: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tab = searchParams.get("tab") || defaultTab

  function onTabChange(value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value === "overview") params.delete("tab")
    else params.set("tab", value)
    const qs = params.toString()
    router.replace(`/modules/hr/employees/${employee.id}${qs ? `?${qs}` : ""}`, { scroll: false })
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground">
          <Link href="/modules/hr/employees">
            <ArrowLeft className="size-4" />
            Employees
          </Link>
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
          <div className="flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{employee.employee_name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{employee.employee_id}</span>
              {employee.designation && <span>· {employee.designation}</span>}
              {employee.department && <span>· {employee.department}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge>{employee.employment_status || "Active"}</Badge>
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
