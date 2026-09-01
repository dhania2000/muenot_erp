import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserAccessibleModules, getUserFeatureSlugs } from "@/lib/permissions"
import { AppShell, type NavItem, type NavChild } from "@/components/app-shell"
import { Users2, TrendingUp, Wallet, UserPlus, Settings2, ShieldCheck } from "lucide-react"

const moduleIcons: Record<string, NavItem["icon"]> = {
  hr: <Users2 className="size-4" />,
  sales: <TrendingUp className="size-4" />,
  finance: <Wallet className="size-4" />,
  recruitment: <UserPlus className="size-4" />,
  operations: <Settings2 className="size-4" />,
}

// Sales sub-pages shown in the sidebar dropdown, each gated by a feature slug.
const HR_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Employees", href: "/modules/hr/employees", feature: "hr.view_employees" },
  { label: "Employee Documents", href: "/modules/hr/employee-documents", feature: "hr.view_employees" },
  { label: "Attendance", href: "/modules/hr/attendance", feature: "hr.view_attendance" },
  { label: "Attendance Regularisation", href: "/modules/hr/attendance-regularisation", feature: "hr.view_regularisation" },
  { label: "HR Support", href: "/modules/hr/support", feature: "hr.view_support" },
  { label: "Offboarding", href: "/modules/hr/offboarding", feature: "hr.view_offboarding" },
  { label: "Leave Requests", href: "/modules/hr/leave-requests", feature: "hr.view_leave_requests" },
  { label: "Leave Balances", href: "/modules/hr/leave-balances", feature: "hr.view_leave_balances" },
  { label: "Leave Quota History", href: "/modules/hr/leave-quota-history", feature: "hr.view_leave_quota_history" },
  { label: "Leave Types", href: "/modules/hr/leave-types", feature: "hr.view_leave_types" },
  { label: "Shifts", href: "/modules/hr/shifts", feature: "hr.view_shifts" },
  { label: "Shift Change Requests", href: "/modules/hr/shift-workflows?kind=requests", feature: "hr.view_shift_change_requests" },
  { label: "Shift Assignments", href: "/modules/hr/shift-workflows?kind=assignments", feature: "hr.view_shift_assignments" },
  { label: "Shift Rotations", href: "/modules/hr/shift-workflows?kind=rotations", feature: "hr.view_shift_rotations" },
  { label: "Rotation Sequences", href: "/modules/hr/shift-workflows?kind=sequences", feature: "hr.view_rotation_sequences" },
  { label: "Rotation Employees", href: "/modules/hr/shift-workflows?kind=employees", feature: "hr.view_rotation_employees" },
  { label: "Promotions", href: "/modules/hr/master-data?kind=promotions", feature: "hr.view_master_data" },
  { label: "Awards", href: "/modules/hr/master-data?kind=awards", feature: "hr.view_master_data" },
  { label: "Appreciations", href: "/modules/hr/master-data?kind=appreciations", feature: "hr.view_master_data" },
  { label: "Passport Visa", href: "/modules/hr/master-data?kind=passport-visa", feature: "hr.view_master_data" },
  { label: "Holidays", href: "/modules/hr/master-data?kind=holidays", feature: "hr.view_master_data" },
  { label: "Departments", href: "/modules/hr/master-data?kind=departments", feature: "hr.view_master_data" },
  { label: "Designations", href: "/modules/hr/master-data?kind=designations", feature: "hr.view_master_data" },
  { label: "HR Emails", href: "/modules/hr/emails", feature: "hr.view_emails" },
  { label: "HR Email Templates", href: "/modules/hr/email-templates", feature: "hr.view_email_templates" },
]

const FINANCE_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Dashboard", href: "/modules/finance", feature: "finance.view_dashboard" },
  { label: "Emails", href: "/modules/finance/emails", feature: "finance.send_emails" },
  { label: "Email Templates", href: "/modules/finance/email-templates", feature: "finance.view_email_templates" },
]

const OPERATIONS_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Operations Dashboard", href: "/modules/operations", feature: "operations.view_dashboard" },
  { label: "Emails", href: "/modules/operations/emails", feature: "operations.send_emails" },
  { label: "Email Templates", href: "/modules/operations/email-templates", feature: "operations.view_email_templates" },
]

const SALES_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Dashboard", href: "/modules/sales/dashboard", feature: "sales.view_dashboard" },
  { label: "Leads", href: "/modules/sales/leads", feature: "sales.view_leads" },
  { label: "Companies", href: "/modules/sales/companies", feature: "sales.view_companies" },
  { label: "Meetings", href: "/modules/sales/meetings", feature: "sales.view_meetings" },
  { label: "Quotations", href: "/modules/sales/quotations", feature: "sales.view_quotations" },
  { label: "Contracts", href: "/modules/sales/contracts", feature: "sales.view_contracts" },
  { label: "Email Templates", href: "/modules/sales/email-templates", feature: "sales.view_email_templates" },
  { label: "Emails", href: "/modules/sales/emails", feature: "sales.send_emails" },
  { label: "Onboarding", href: "/modules/sales/onboarding", feature: "sales.manage_onboarding" },
  { label: "Forecast", href: "/modules/sales/forecast", feature: "sales.view_dashboard" },
  { label: "Get Email Name", href: "/modules/sales/get-email-name", feature: "sales.get_email_name" },
]

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect("/login")

  const modules = await getUserAccessibleModules(session.userId, session.role)

  const granted = session.role === "admin" ? null : new Set(await getUserFeatureSlugs(session.userId))
  const canAccess = (feature: string) => session.role === "admin" || granted!.has(feature)

  const navItems: NavItem[] = [
    ...(session.role === "admin"
      ? [{ label: "Admin panel", href: "/admin", icon: <ShieldCheck className="size-4" /> }]
      : []),
    ...modules.map((m) => {
      const item: NavItem = {
        label: m.name,
        href: `/modules/${m.slug}`,
        icon: moduleIcons[m.slug] ?? <Settings2 className="size-4" />,
      }
      if (m.slug === "hr" || m.slug === "sales" || m.slug === "finance" || m.slug === "operations") {
        const source = m.slug === "hr" ? HR_CHILDREN : m.slug === "finance" ? FINANCE_CHILDREN : m.slug === "operations" ? OPERATIONS_CHILDREN : SALES_CHILDREN
        const children: NavChild[] = source.filter((c) => canAccess(c.feature)).map((c) => ({
          label: c.label,
          href: c.href,
        }))
        if (children.length > 0) item.children = children
      }
      return item
    }),
  ]

  return (
    <AppShell navItems={navItems} user={session}>
      {children}
    </AppShell>
  )
}
