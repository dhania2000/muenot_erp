/**
 * Spec32 (#176-179) — Contextual help center: pure logic.
 * ---------------------------------------------------------------------------
 * A curated map of help topics per workspace module. Each topic can be gated by
 * a permission-matrix feature slug, so the help panel only surfaces links the
 * viewer is actually allowed to use (a hidden module contributes no links).
 * Knowledge-base search is delegated to the existing `/api/knowledge-base`
 * endpoint by the client, so we never duplicate that subsystem here.
 *
 * No DB / server-only imports — the permission filter is injected as a
 * predicate so this stays unit-testable.
 */

export type HelpTopic = {
  title: string
  description: string
  href: string
  /** Optional permission slug controlling visibility of this link. */
  feature?: string
  /** External docs open in a new tab. */
  external?: boolean
}

/** Always-available links, independent of the current module. */
export const GENERAL_HELP: HelpTopic[] = [
  { title: "Getting started guide", description: "Walk through setting up your workspace.", href: "/modules/knowledge-base", feature: "knowledge-base.view" },
  { title: "Keyboard shortcuts", description: "Press Ctrl/Cmd + K to search and jump anywhere.", href: "/dashboard" },
]

/**
 * Module key → contextual topics. Keys match the sidebar module slugs used by
 * `resolveModuleKey`. Feature slugs mirror the permission matrix used elsewhere.
 */
export const HELP_TOPICS: Record<string, HelpTopic[]> = {
  dashboard: [
    { title: "Understand your dashboard", description: "What the summary cards and widgets mean.", href: "/modules/knowledge-base", feature: "knowledge-base.view" },
  ],
  hr: [
    { title: "Add and manage employees", description: "Create employee records and assign roles.", href: "/modules/hr/employees", feature: "hr.view_employees" },
    { title: "Attendance & leave", description: "How clock-in, regularisation and leave requests work.", href: "/modules/hr/attendance", feature: "hr.view_attendance" },
    { title: "Letters & templates", description: "Generate offer and confirmation letters.", href: "/modules/hr/letters", feature: "hr.view_letters" },
  ],
  finance: [
    { title: "Raise a sales invoice", description: "Create, send and track customer invoices.", href: "/modules/finance/sales-invoices", feature: "finance.view_sales_invoices" },
    { title: "Record expenses", description: "Log and categorize business expenses.", href: "/modules/finance/expenses", feature: "finance.view_expenses" },
    { title: "GST & TDS filing", description: "Prepare statutory returns from your ledger.", href: "/modules/finance/gst-filing", feature: "finance.gst_filing" },
  ],
  sales: [
    { title: "Manage leads & deals", description: "Track your pipeline from lead to close.", href: "/modules/sales", feature: "sales.view_dashboard" },
  ],
  recruitment: [
    { title: "Post a job & screen candidates", description: "From requisition to offer.", href: "/modules/recruitment/jobs", feature: "recruitment.view_jobs" },
    { title: "Schedule interviews", description: "Coordinate panels and capture feedback.", href: "/modules/recruitment/interview-schedule", feature: "recruitment.schedule_interviews" },
  ],
  operations: [
    { title: "Run projects & tasks", description: "Plan work, milestones and deliverables.", href: "/modules/operations/projects", feature: "operations.view_projects" },
    { title: "Timesheets", description: "Track time against projects.", href: "/modules/operations/timesheets", feature: "operations.view_timesheets" },
  ],
  marketing: [
    { title: "Build a campaign", description: "Create and launch marketing campaigns.", href: "/modules/marketing/campaigns", feature: "marketing.view_campaigns" },
  ],
  tickets: [
    { title: "Handle support tickets", description: "Triage, assign and resolve requests.", href: "/modules/tickets", feature: "tickets.view_dashboard" },
  ],
  "knowledge-base": [
    { title: "Search company knowledge", description: "Find articles, policies and how-tos.", href: "/modules/knowledge-base", feature: "knowledge-base.view" },
  ],
  admin: [
    { title: "Company settings", description: "Branding, addresses and defaults.", href: "/admin/settings/company", feature: "settings.company" },
    { title: "Permissions & roles", description: "Control who can access each module.", href: "/admin/permissions", feature: "settings.permissions" },
    { title: "Email & storage", description: "Connect sending and file storage.", href: "/admin/settings/email", feature: "settings.email" },
  ],
}

/**
 * Map a pathname to a module key. Handles `/modules/<key>/...`, the admin area
 * and the dashboard; falls back to "dashboard" so there is always a context.
 */
export function resolveModuleKey(pathname: string | null | undefined): string {
  const path = (pathname ?? "").split("?")[0]
  if (!path || path === "/" || path.startsWith("/dashboard")) return "dashboard"
  if (path.startsWith("/admin")) return "admin"
  const m = /^\/modules\/([a-z0-9-]+)/.exec(path)
  if (m) return m[1]
  return "dashboard"
}

/**
 * The help topics for a module, filtered by a permission predicate. Topics
 * without a `feature` are always shown; the rest require `hasFeature(slug)`.
 * General links are appended (also permission-filtered) and de-duplicated.
 */
export function getHelpTopics(moduleKey: string, hasFeature: (slug: string) => boolean): HelpTopic[] {
  const module = HELP_TOPICS[moduleKey] ?? []
  const seen = new Set<string>()
  const keep = (t: HelpTopic) => {
    if (t.feature && !hasFeature(t.feature)) return false
    if (seen.has(t.href + t.title)) return false
    seen.add(t.href + t.title)
    return true
  }
  return [...module.filter(keep), ...GENERAL_HELP.filter(keep)]
}
