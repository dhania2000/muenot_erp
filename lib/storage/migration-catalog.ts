/**
 * Catalog of ERP modules and their sub-modules used by the Storage → Migration
 * feature. An admin picks a module + sub-module here and maps that data source
 * to a specific folder in their connected storage.
 *
 * This mirrors the workspace sidebar (lib/workspace-nav.tsx) but is a plain,
 * client-importable data structure (no server-only deps, no permission gating)
 * so the migration dropdowns can render on the client.
 */

export type MigrationSubModule = { key: string; label: string }
export type MigrationModule = { key: string; label: string; subModules: MigrationSubModule[] }

const sub = (label: string, key?: string): MigrationSubModule => ({
  label,
  key: key ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
})

export const MIGRATION_MODULES: MigrationModule[] = [
  {
    key: "hr",
    label: "HR",
    subModules: [
      sub("Employees"),
      sub("Employee Documents"),
      sub("Attendance"),
      sub("Attendance Regularisation"),
      sub("Screen Activity Monitoring"),
      sub("HR Support"),
      sub("Offboarding"),
      sub("Leave Requests"),
      sub("Leave Balances"),
      sub("Shifts"),
      sub("HR Master Data"),
      sub("HR Emails"),
      sub("Letter Templates"),
      sub("Letters"),
    ],
  },
  {
    key: "finance",
    label: "Finance",
    subModules: [
      sub("Sales Invoices"),
      sub("Purchase Bills"),
      sub("Expenses"),
      sub("FTE Invoices"),
      sub("Freelance Invoices"),
      sub("Vendors"),
      sub("Bank Transactions"),
      sub("Chart of Accounts"),
      sub("Fixed Assets"),
      sub("Loans & Advances"),
      sub("Investments"),
      sub("Legal Entities"),
      sub("GST Filing"),
      sub("TDS Filing"),
      sub("Journal Entries"),
      sub("General Ledger"),
      sub("Financial Reports"),
    ],
  },
  {
    key: "sales",
    label: "Sales",
    subModules: [
      sub("Leads"),
      sub("Follow-ups"),
      sub("Companies"),
      sub("Meetings"),
      sub("Quotations"),
      sub("Contracts"),
      sub("Onboarding"),
      sub("Forecast"),
    ],
  },
  {
    key: "recruitment",
    label: "Recruitment",
    subModules: [
      sub("Job Requisitions"),
      sub("Jobs"),
      sub("Candidate Database"),
      sub("Job Applications"),
      sub("Screening"),
      sub("Talent Pool"),
      sub("Candidate Documents"),
      sub("Interview Schedule"),
      sub("Interview Feedback"),
      sub("Selection & Offers"),
      sub("Job Offer Letter"),
      sub("Background Verification"),
      sub("Onboarding", "recruitment-onboarding"),
      sub("Career Site"),
    ],
  },
  {
    key: "operations",
    label: "Operations",
    subModules: [
      sub("Project Management"),
      sub("Project Milestones"),
      sub("Project Deliverables"),
      sub("Project Documents"),
      sub("Tasks"),
      sub("Work Orders"),
      sub("Meetings", "operations-meetings"),
      sub("Resources"),
      sub("Timesheets"),
      sub("Quality Reviews"),
      sub("QA Audits"),
      sub("SLA Monitoring"),
      sub("Issue Register"),
      sub("SOPs"),
      sub("Checklists"),
      sub("Approvals"),
    ],
  },
  {
    key: "marketing",
    label: "Marketing",
    subModules: [
      sub("Contacts"),
      sub("Lead Generation"),
      sub("Journeys"),
      sub("Marketing Planner"),
      sub("Campaigns"),
      sub("Website Analytics"),
      sub("Library"),
    ],
  },
  {
    key: "clients",
    label: "Clients",
    subModules: [sub("Clients")],
  },
  {
    key: "tickets",
    label: "Tickets",
    subModules: [sub("All Tickets")],
  },
  {
    key: "products",
    label: "Products",
    subModules: [sub("Product Catalog"), sub("Product Documents")],
  },
  {
    key: "legal",
    label: "Legal",
    subModules: [sub("Contracts"), sub("Templates"), sub("Esign")],
  },
  {
    key: "assets",
    label: "Assets & Subscriptions",
    subModules: [sub("Employee Assets"), sub("Company Subscriptions")],
  },
  {
    key: "knowledge-base",
    label: "Knowledge Base",
    subModules: [sub("Articles"), sub("Attachments")],
  },
  {
    key: "billing",
    label: "Subscription & Billing",
    subModules: [
      sub("Subscriptions"),
      sub("Plans"),
      sub("Invoices & Credit Notes"),
      sub("Payments"),
      sub("Renewals"),
      sub("Billing Reports"),
    ],
  },
]

export function getMigrationModule(key: string): MigrationModule | undefined {
  return MIGRATION_MODULES.find((m) => m.key === key)
}

export function migrationLabels(moduleKey: string, subKey: string): { module: string; subModule: string } | null {
  const mod = getMigrationModule(moduleKey)
  if (!mod) return null
  const s = mod.subModules.find((x) => x.key === subKey)
  if (!s) return null
  return { module: mod.label, subModule: s.label }
}
