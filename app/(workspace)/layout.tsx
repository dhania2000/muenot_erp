import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getUserAccessibleModules, getFeatureChecker } from "@/lib/permissions"
import { getPublicSettings } from "@/lib/settings/server"
import { SettingsProvider } from "@/components/providers/settings-provider"
import { SettingsBranding } from "@/components/providers/settings-branding"
import { AppShell, type NavItem, type NavChild } from "@/components/app-shell"
import { Users2, TrendingUp, Wallet, UserPlus, Settings2, ShieldCheck, BriefcaseBusiness, TicketCheck, Package, Scale, ExternalLink, Megaphone, MessageCircle } from "lucide-react"

function settingEnabled(v: string | undefined, fallback = true) {
  if (v == null) return fallback
  const t = v.trim().toLowerCase()
  return t === "enabled" || t === "true" || t === "1" || t === "yes"
}

const moduleIcons: Record<string, NavItem["icon"]> = {
  hr: <Users2 className="size-4" />,
  sales: <TrendingUp className="size-4" />,
  finance: <Wallet className="size-4" />,
  recruitment: <UserPlus className="size-4" />,
  operations: <Settings2 className="size-4" />,
  clients: <BriefcaseBusiness className="size-4" />,
  tickets: <TicketCheck className="size-4" />,
  products: <Package className="size-4" />,
  legal: <Scale className="size-4" />,
  marketing: <Megaphone className="size-4" />,
}

// Marketing sub-pages shown in the sidebar dropdown. The Marketing module is
// not (yet) stored in the `modules` table, so it is injected into the sidebar
// directly below and its children are not permission-gated.
const MARKETING_CHILDREN: NavChild[] = [
  { label: "Dashboard", href: "/modules/marketing/dashboard" },
  { label: "Contacts", href: "/modules/marketing/contacts" },
  { label: "Lead Generation", href: "/modules/marketing/lead-generation" },
  { label: "Journeys", href: "/modules/marketing/journeys" },
  { label: "Marketing Planner", href: "/modules/marketing/planner" },
  {
    label: "Marketing Campaigns",
    children: [
      { label: "Overview", href: "/modules/marketing/campaigns" },
      { label: "Email", href: "/modules/marketing/campaigns/email" },
      { label: "Social", href: "/modules/marketing/campaigns/social" },
    ],
  },
  { label: "Website Analytics", href: "/modules/marketing/website-analytics" },
  { label: "Library", href: "/modules/marketing/library" },
]

type FeatureChild = { label: string; href?: string; feature?: string; children?: FeatureChild[] }

// Sales sub-pages shown in the sidebar dropdown, each gated by a feature slug.
const HR_CHILDREN: FeatureChild[] = [
  { label: "HR Dashboard", href: "/modules/hr/dashboard", feature: "hr.view_dashboard" },
  { label: "Employees", href: "/modules/hr/employees", feature: "hr.view_employees" },
  { label: "Employee Documents", href: "/modules/hr/employee-documents", feature: "hr.view_documents" },
  { label: "Attendance", href: "/modules/hr/attendance", feature: "hr.view_attendance" },
  { label: "Attendance Regularisation", href: "/modules/hr/attendance-regularisation", feature: "hr.view_regularisation" },
  { label: "HR Support", href: "/modules/hr/support", feature: "hr.view_support" },
  { label: "Offboarding", href: "/modules/hr/offboarding", feature: "hr.view_offboarding" },
  {
    label: "Leaves",
    children: [
      { label: "Leave Requests", href: "/modules/hr/leave-requests", feature: "hr.view_leave_requests" },
      { label: "Leave Balances", href: "/modules/hr/leave-balances", feature: "hr.view_leave_balances" },
      { label: "Leave Quota History", href: "/modules/hr/leave-quota-history", feature: "hr.view_leave_quota_history" },
      { label: "Leave Types", href: "/modules/hr/leave-types", feature: "hr.view_leave_types" },
    ],
  },
  {
    label: "Shifts",
    children: [
      { label: "Shifts", href: "/modules/hr/shifts", feature: "hr.view_shifts" },
      { label: "Shift Change Requests", href: "/modules/hr/shift-change-requests", feature: "hr.view_shift_change_requests" },
      { label: "Shift Assignments", href: "/modules/hr/shift-workflows?kind=assignments", feature: "hr.view_shift_assignments" },
      { label: "Shift Rotations", href: "/modules/hr/shift-workflows?kind=rotations", feature: "hr.view_shift_rotations" },
      { label: "Rotation Sequences", href: "/modules/hr/shift-workflows?kind=sequences", feature: "hr.view_rotation_sequences" },
      { label: "Rotation Employees", href: "/modules/hr/shift-workflows?kind=employees", feature: "hr.view_rotation_employees" },
    ],
  },
  { label: "HR Master Data", href: "/modules/hr/master-data", feature: "hr.view_master_data" },
  { label: "HR Emails", href: "/modules/hr/emails", feature: "hr.view_emails" },
  { label: "HR Email Templates", href: "/modules/hr/email-templates", feature: "hr.view_email_templates" },
  { label: "Letter Templates", href: "/modules/hr/letter-templates", feature: "hr.view_letter_templates" },
  { label: "Letters", href: "/modules/hr/letters", feature: "hr.view_letters" },
  { label: "Generate Letter", href: "/modules/hr/letters/generate", feature: "hr.view_letters" },
]

const FINANCE_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Dashboard", href: "/modules/finance", feature: "finance.view_dashboard" },
  { label: "Sales Invoices", href: "/modules/finance/sales-invoices", feature: "finance.view_sales_invoices" },
  { label: "Purchase Bills", href: "/modules/finance/purchase-bills", feature: "finance.view_purchase_bills" },
  { label: "Expenses", href: "/modules/finance/expenses", feature: "finance.view_expenses" },
  { label: "FTE Invoices", href: "/modules/finance/fte-invoices", feature: "finance.view_fte_invoices" },
  { label: "Freelance Invoices", href: "/modules/finance/freelance-invoices", feature: "finance.view_freelance_invoices" },
  { label: "Bank Transactions", href: "/modules/finance/bank-transactions", feature: "finance.view_bank_transactions" },
  { label: "Bank & Cash", href: "/modules/finance/bank-cash", feature: "finance.view_bank_cash" },
  { label: "Chart of Accounts", href: "/modules/finance/chart-of-accounts", feature: "finance.view_chart_of_accounts" },
  { label: "Customer / Vendor", href: "/modules/finance/customers-vendors", feature: "finance.view_customers_vendors" },
  { label: "GST Filing", href: "/modules/finance/gst-filing", feature: "finance.gst_filing" },
  { label: "TDS Filing", href: "/modules/finance/tds-filing", feature: "finance.tds_filing" },
  { label: "Journal Entries", href: "/modules/finance/journal-entries", feature: "finance.journal_entries" },
  { label: "General Ledger", href: "/modules/finance/general-ledger", feature: "finance.general_ledger" },
  { label: "Financial Reports", href: "/modules/finance/financial-reports", feature: "finance.financial_reports" },
  { label: "Emails", href: "/modules/finance/emails", feature: "finance.send_emails" },
  { label: "Email Templates", href: "/modules/finance/email-templates", feature: "finance.view_email_templates" },
]

const RECRUITMENT_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Recruit Dashboard", href: "/modules/recruitment", feature: "recruitment.view_dashboard" },
  { label: "Jobs", href: "/modules/recruitment/jobs", feature: "recruitment.view_jobs" },
  { label: "Job Applications", href: "/modules/recruitment/job-applications", feature: "recruitment.view_applications" },
  { label: "Interview Schedule", href: "/modules/recruitment/interview-schedule", feature: "recruitment.schedule_interviews" },
  { label: "Job Offer Letter", href: "/modules/recruitment/job-offer-letter", feature: "recruitment.manage_offers" },
  { label: "Job Skills", href: "/modules/recruitment/job-skills", feature: "recruitment.view_skills" },
  { label: "Candidate Database", href: "/modules/recruitment/candidate-database", feature: "recruitment.view_candidates" },
  { label: "Email", href: "/modules/recruitment/emails", feature: "recruitment.view_emails" },
  { label: "Email Templates", href: "/modules/recruitment/email-templates", feature: "recruitment.view_email_templates" },
  { label: "Recruit Report", href: "/modules/recruitment/recruit-job-report", feature: "recruitment.view_reports" },
  { label: "Career Site", href: "/modules/recruitment/career-site", feature: "recruitment.view_jobs" },
]

const OPERATIONS_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Operations Dashboard", href: "/modules/operations", feature: "operations.view_dashboard" },
  { label: "Resources", href: "/modules/operations/resources", feature: "operations.view_resources" },
  { label: "Projects", href: "/modules/operations/projects", feature: "operations.view_projects" },
  { label: "Allocations", href: "/modules/operations/allocations", feature: "operations.view_allocations" },
  { label: "Quality & SLA Reviews", href: "/modules/operations/quality", feature: "operations.view_quality" },
  { label: "Issues", href: "/modules/operations/issues", feature: "operations.view_issues" },
  { label: "Emails", href: "/modules/operations/emails", feature: "operations.send_emails" },
  { label: "Email Templates", href: "/modules/operations/email-templates", feature: "operations.view_email_templates" },
]

const CLIENTS_CHILDREN = [
  { label: "Clients", href: "/modules/clients/clients", feature: "clients.view_clients" },
]

const TICKETS_CHILDREN = [
  { label: "All Tickets", href: "/modules/tickets/all", feature: "tickets.view_tickets" },
]

const PRODUCTS_CHILDREN = [
  { label: "Product Catalog", href: "/modules/products/catalog", feature: "products.view_products" },
]

const LEGAL_CHILDREN = [
  { label: "Contracts", href: "/modules/legal/contracts", feature: "legal.view_contracts" },
  { label: "Esign", href: "/modules/legal/esign", feature: "legal.view_esign" },
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

  const settings = await getPublicSettings()

  const HIDDEN_MODULES = new Set(["biolinks", "biometric", "letter", "monitor-center", "monitor center"])
  const modules = (await getUserAccessibleModules(session.userId, session.role))
    .filter((m) => !HIDDEN_MODULES.has(m.slug.toLowerCase()) && !HIDDEN_MODULES.has(m.name.toLowerCase()))
    // Respect the Module Settings toggles (module.hr, module.finance, ...).
    .filter((m) => settingEnabled(settings[`module.${m.slug.toLowerCase()}`]))

  // Matrix-aware feature check so sidebar sub-navigation reflects the permission
  // matrix an admin configured (not just the legacy user_permissions grants).
  const canAccess = await getFeatureChecker(session.userId, session.role)

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
      if (["hr", "sales", "finance", "recruitment", "operations", "clients", "products", "legal"].includes(m.slug)) {
        const source = m.slug === "hr" ? HR_CHILDREN : m.slug === "finance" ? FINANCE_CHILDREN : m.slug === "recruitment" ? RECRUITMENT_CHILDREN : m.slug === "operations" ? OPERATIONS_CHILDREN : m.slug === "clients" ? CLIENTS_CHILDREN : m.slug === "products" ? PRODUCTS_CHILDREN : m.slug === "legal" ? LEGAL_CHILDREN : SALES_CHILDREN
        // Recursively keep only accessible leaves; drop groups that end up empty.
        const buildChildren = (nodes: FeatureChild[]): NavChild[] =>
          nodes.flatMap<NavChild>((c) => {
            if (c.children && c.children.length > 0) {
              const sub = buildChildren(c.children)
              return sub.length > 0 ? [{ label: c.label, children: sub }] : []
            }
            return c.feature && !canAccess(c.feature) ? [] : [{ label: c.label, href: c.href }]
          })
        const children = buildChildren(source as FeatureChild[])
        if (children.length > 0) item.children = children
      }
      return item
    }),
  ]

  // WhatsApp is its own top-level module (not stored in the modules table).
  // Place it directly below the Messages module when Messages is present,
  // otherwise append it so it is always reachable.
  if (!navItems.some((i) => i.href === "/modules/whatsapp")) {
    const whatsappItem: NavItem = {
      label: "WhatsApp",
      href: "/modules/whatsapp",
      icon: <MessageCircle className="size-4" />,
    }
    const messagesIndex = navItems.findIndex((i) => i.href === "/modules/messages")
    if (messagesIndex >= 0) navItems.splice(messagesIndex + 1, 0, whatsappItem)
    else navItems.push(whatsappItem)
  }

  // Inject the Marketing module (not stored in the modules table) so the
  // sidebar always exposes it and its sub-pages.
  if (!navItems.some((i) => i.href === "/modules/marketing")) {
    navItems.push({
      label: "Marketing",
      href: "/modules/marketing",
      icon: <Megaphone className="size-4" />,
      children: MARKETING_CHILDREN,
    })
  }

  // Optional custom sidebar link driven by Custom Link Settings.
  if (settingEnabled(settings["customlink.enabled"], false) && settings["customlink.url"]) {
    navItems.push({
      label: settings["customlink.label"] || "Custom Link",
      href: settings["customlink.url"],
      icon: <ExternalLink className="size-4" />,
      external: true,
      openInNewTab: settingEnabled(settings["customlink.open_new_tab"], true),
    })
  }

  return (
    <SettingsProvider initial={settings}>
      <SettingsBranding />
      <AppShell navItems={navItems} user={session} brandName={settings["company.name"]} logoUrl={settings["company.logo"]}>
        {children}
      </AppShell>
    </SettingsProvider>
  )
}
