import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserAccessibleModules, getUserFeatureSlugs } from "@/lib/permissions"
import { AppShell, type NavItem, type NavChild } from "@/components/app-shell"
import { Users2, TrendingUp, Wallet, UserPlus, Settings2, ShieldCheck, BriefcaseBusiness, TicketCheck, Package } from "lucide-react"

const moduleIcons: Record<string, NavItem["icon"]> = {
  hr: <Users2 className="size-4" />,
  sales: <TrendingUp className="size-4" />,
  finance: <Wallet className="size-4" />,
  recruitment: <UserPlus className="size-4" />,
  operations: <Settings2 className="size-4" />,
  clients: <BriefcaseBusiness className="size-4" />,
  tickets: <TicketCheck className="size-4" />,
  products: <Package className="size-4" />,
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
  { label: "Sales Invoices", href: "/modules/finance/sales-invoices", feature: "finance.view_dashboard" },
  { label: "Purchase Bills", href: "/modules/finance/purchase-bills", feature: "finance.view_dashboard" },
  { label: "Expenses", href: "/modules/finance/expenses", feature: "finance.view_dashboard" },
  { label: "FTE Invoices", href: "/modules/finance/fte-invoices", feature: "finance.view_dashboard" },
  { label: "Freelance Invoices", href: "/modules/finance/freelance-invoices", feature: "finance.view_dashboard" },
  { label: "Bank Transactions", href: "/modules/finance/bank-transactions", feature: "finance.view_dashboard" },
  { label: "Bank & Cash", href: "/modules/finance/bank-cash", feature: "finance.view_dashboard" },
  { label: "Chart of Accounts", href: "/modules/finance/chart-of-accounts", feature: "finance.view_dashboard" },
  { label: "Customer / Vendor", href: "/modules/finance/customers-vendors", feature: "finance.view_dashboard" },
  { label: "GST Filing", href: "/modules/finance/gst-filing", feature: "finance.gst_filing" },
  { label: "TDS Filing", href: "/modules/finance/tds-filing", feature: "finance.tds_filing" },
  { label: "Journal Entries", href: "/modules/finance/journal-entries", feature: "finance.journal_entries" },
  { label: "General Ledger", href: "/modules/finance/general-ledger", feature: "finance.general_ledger" },
  { label: "Financial Reports", href: "/modules/finance/financial-reports", feature: "finance.financial_reports" },
  { label: "Emails", href: "/modules/finance/emails", feature: "finance.send_emails" },
  { label: "Email Templates", href: "/modules/finance/email-templates", feature: "finance.view_email_templates" },
]

const RECRUITMENT_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Dashboard", href: "/modules/recruitment", feature: "recruitment.view_dashboard" },
  { label: "Job Requisitions", href: "/modules/recruitment/job-requisitions", feature: "recruitment.view_requisitions" },
  { label: "Recruitment Campaigns", href: "/modules/recruitment/recruitment-campaigns", feature: "recruitment.view_campaigns" },
  { label: "Candidate Master", href: "/modules/recruitment/candidate-master", feature: "recruitment.view_candidates" },
  { label: "Screening", href: "/modules/recruitment/screening", feature: "recruitment.view_screening" },
  { label: "Interview Tracker", href: "/modules/recruitment/interview-tracker", feature: "recruitment.schedule_interviews" },
  { label: "Assessment Tracker", href: "/modules/recruitment/assessment-tracker", feature: "recruitment.view_assessments" },
  { label: "Selection & Offers", href: "/modules/recruitment/selection-offers", feature: "recruitment.manage_offers" },
  { label: "Recruitment Sources", href: "/modules/recruitment/recruitment-sources", feature: "recruitment.view_sources" },
  { label: "Recruitment Settings", href: "/modules/recruitment/recruitment-settings", feature: "recruitment.view_settings" },
]

const OPERATIONS_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Operations Dashboard", href: "/modules/operations", feature: "operations.view_dashboard" },
  { label: "Resources", href: "/modules/operations/resources", feature: "operations.view_dashboard" },
  { label: "Projects", href: "/modules/operations/projects", feature: "operations.view_dashboard" },
  { label: "Allocations", href: "/modules/operations/allocations", feature: "operations.view_dashboard" },
  { label: "Quality & SLA Reviews", href: "/modules/operations/quality", feature: "operations.view_dashboard" },
  { label: "Issues", href: "/modules/operations/issues", feature: "operations.view_dashboard" },
  { label: "Emails", href: "/modules/operations/emails", feature: "operations.send_emails" },
  { label: "Email Templates", href: "/modules/operations/email-templates", feature: "operations.view_email_templates" },
]

const CLIENTS_CHILDREN = [
  { label: "Dashboard", href: "/modules/clients", feature: "clients.view_dashboard" },
  { label: "Clients", href: "/modules/clients/clients", feature: "clients.view_clients" },
]

const TICKETS_CHILDREN = [
  { label: "Dashboard", href: "/modules/tickets", feature: "tickets.view_dashboard" },
  { label: "All Tickets", href: "/modules/tickets/all", feature: "tickets.view_tickets" },
]

const PRODUCTS_CHILDREN = [
  { label: "Dashboard", href: "/modules/products", feature: "products.view_dashboard" },
  { label: "Product Catalog", href: "/modules/products/catalog", feature: "products.view_products" },
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
      if (["hr", "sales", "finance", "recruitment", "operations", "clients", "tickets", "products"].includes(m.slug)) {
        const source = m.slug === "hr" ? HR_CHILDREN : m.slug === "finance" ? FINANCE_CHILDREN : m.slug === "recruitment" ? RECRUITMENT_CHILDREN : m.slug === "operations" ? OPERATIONS_CHILDREN : m.slug === "clients" ? CLIENTS_CHILDREN : m.slug === "tickets" ? TICKETS_CHILDREN : m.slug === "products" ? PRODUCTS_CHILDREN : SALES_CHILDREN
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
