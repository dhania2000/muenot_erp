// Central registry of all ERP modules and their features.
// This single source of truth drives: the sidebar navigation, the admin
// access-control matrix, and the database seed for modules/features.

export type FeatureDef = {
  key: string
  name: string
  href: string
  // Whether a real page is implemented today. Others render a "coming soon" state.
  implemented?: boolean
}

export type ModuleDef = {
  key: string
  name: string
  description: string
  features: FeatureDef[]
}

export const MODULES: ModuleDef[] = [
  {
    key: "sales",
    name: "Sales",
    description: "CRM, pipeline, quotations, contracts and revenue",
    features: [
      { key: "dashboard", name: "Sales Dashboard", href: "/sales", implemented: true },
      { key: "leads", name: "Leads", href: "/sales/leads", implemented: true },
      { key: "followups", name: "Follow-ups", href: "/sales/followups", implemented: true },
      { key: "companies", name: "Companies", href: "/sales/companies", implemented: true },
      { key: "meetings", name: "Meetings", href: "/sales/meetings", implemented: true },
      { key: "quotations", name: "Quotations", href: "/sales/quotations", implemented: true },
      { key: "contracts", name: "Contracts", href: "/sales/contracts", implemented: true },
      { key: "onboarding", name: "Client Onboarding", href: "/sales/onboarding", implemented: true },
      { key: "deals", name: "Won / Lost Deals", href: "/sales/deals", implemented: true },
      { key: "forecast", name: "Revenue Forecast", href: "/sales/forecast", implemented: true },
      { key: "outreach", name: "Email Outreach", href: "/sales/outreach", implemented: true },
      { key: "email_finder", name: "Email Finder", href: "/sales/email-finder", implemented: true },
    ],
  },
  {
    key: "hr",
    name: "HR",
    description: "People, attendance, payroll and leave",
    features: [
      { key: "employees", name: "Employees", href: "/hr/employees" },
      { key: "attendance", name: "Attendance", href: "/hr/attendance" },
      { key: "payroll", name: "Payroll", href: "/hr/payroll" },
      { key: "leaves", name: "Leaves", href: "/hr/leaves" },
    ],
  },
  {
    key: "finance",
    name: "Finance",
    description: "Invoices, expenses and financial reports",
    features: [
      { key: "invoices", name: "Invoices", href: "/finance/invoices" },
      { key: "expenses", name: "Expenses", href: "/finance/expenses" },
      { key: "reports", name: "Reports", href: "/finance/reports" },
    ],
  },
  {
    key: "recruitment",
    name: "Recruitment",
    description: "Jobs, candidates and interviews",
    features: [
      { key: "jobs", name: "Job Openings", href: "/recruitment/jobs" },
      { key: "candidates", name: "Candidates", href: "/recruitment/candidates" },
      { key: "interviews", name: "Interviews", href: "/recruitment/interviews" },
    ],
  },
  {
    key: "operations",
    name: "Operations",
    description: "Projects, tasks and resource planning",
    features: [
      { key: "projects", name: "Projects", href: "/operations/projects" },
      { key: "tasks", name: "Tasks", href: "/operations/tasks" },
      { key: "resources", name: "Resources", href: "/operations/resources" },
    ],
  },
]

export function getModule(key: string): ModuleDef | undefined {
  return MODULES.find((m) => m.key === key)
}

export function getFeature(moduleKey: string, featureKey: string): FeatureDef | undefined {
  return getModule(moduleKey)?.features.find((f) => f.key === featureKey)
}

// A flat list of "module.feature" permission keys, used across the app.
export function allPermissionKeys(): string[] {
  return MODULES.flatMap((m) => m.features.map((f) => `${m.key}.${f.key}`))
}
