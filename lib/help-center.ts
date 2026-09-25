/**
 * Spec32 (#176-179) — Contextual help center: pure logic.
 * ---------------------------------------------------------------------------
 * A curated map of help topics per workspace module. Each topic can be gated by
 * a permission-matrix feature slug, by the tenant's module toggle
 * (`module.<slug>` setting, the same switch the sidebar uses) and/or by the
 * tenant-admin role. A hidden module therefore contributes no links, and a
 * user never sees a link to a screen they cannot open.
 *
 * Knowledge-base search is delegated to the existing `/api/knowledge-base`
 * endpoint by the client, so that subsystem is not duplicated here.
 *
 * No DB / server-only imports — access checks are injected so this stays
 * unit-testable.
 */

export type HelpTopic = {
  title: string
  description: string
  href: string
  /** Permission-matrix slug required to see this link. */
  feature?: string
  /** Tenant module toggle (`module.<slug>`) that must be enabled. */
  module?: string
  /** Only tenant admins can use the target screen. */
  adminOnly?: boolean
}

export type HelpAccess = {
  hasFeature: (slug: string) => boolean
  isModuleEnabled: (slug: string) => boolean
  isAdmin: boolean
}

export const KNOWLEDGE_BASE_HREF = "/modules/tickets/knowledge-base"

/** Always-available links, independent of the current module. */
export const GENERAL_HELP: HelpTopic[] = [
  {
    title: "Browse the knowledge base",
    description: "Articles, policies and how-tos written by your team.",
    href: KNOWLEDGE_BASE_HREF,
    feature: "knowledge-base.view",
    module: "tickets",
  },
  { title: "Keyboard shortcuts", description: "Press Ctrl/Cmd + K to search and jump anywhere.", href: "/dashboard" },
]

/** Module key → contextual topics. Keys match `resolveModuleKey`. */
export const HELP_TOPICS: Record<string, HelpTopic[]> = {
  dashboard: [
    { title: "Understand your dashboard", description: "What the summary cards and widgets mean.", href: "/dashboard" },
  ],
  hr: [
    { title: "Add and manage employees", description: "Create employee records and assign roles.", href: "/modules/hr/employees", feature: "hr.view_employees", module: "hr" },
    { title: "Attendance & leave", description: "How clock-in, regularisation and leave requests work.", href: "/modules/hr/attendance", feature: "hr.view_attendance", module: "hr" },
    { title: "Letters & templates", description: "Generate offer and confirmation letters.", href: "/modules/hr/letters", feature: "hr.view_letters", module: "hr" },
  ],
  finance: [
    { title: "Raise a sales invoice", description: "Create, send and track customer invoices.", href: "/modules/finance/sales-invoices", feature: "finance.view_sales_invoices", module: "finance" },
    { title: "Record expenses", description: "Log and categorize business expenses.", href: "/modules/finance/expenses", feature: "finance.view_expenses", module: "finance" },
    { title: "GST & TDS filing", description: "Prepare statutory returns from your ledger.", href: "/modules/finance/gst-filing", feature: "finance.gst_filing", module: "finance" },
  ],
  sales: [
    { title: "Manage leads & deals", description: "Track your pipeline from lead to close.", href: "/modules/sales", feature: "sales.view_dashboard", module: "sales" },
  ],
  recruitment: [
    { title: "Post a job & screen candidates", description: "From requisition to offer.", href: "/modules/recruitment/jobs", feature: "recruitment.view_jobs", module: "recruitment" },
    { title: "Schedule interviews", description: "Coordinate panels and capture feedback.", href: "/modules/recruitment/interview-schedule", feature: "recruitment.schedule_interviews", module: "recruitment" },
  ],
  operations: [
    { title: "Run projects & tasks", description: "Plan work, milestones and deliverables.", href: "/modules/operations/projects", feature: "operations.view_projects", module: "operations" },
    { title: "Timesheets", description: "Track time against projects.", href: "/modules/operations/timesheets", feature: "operations.view_timesheets", module: "operations" },
  ],
  marketing: [
    { title: "Build a campaign", description: "Create and launch marketing campaigns.", href: "/modules/marketing/campaigns", feature: "marketing.view_campaigns", module: "marketing" },
  ],
  tickets: [
    { title: "Handle support tickets", description: "Triage, assign and resolve requests.", href: "/modules/tickets", feature: "tickets.view_dashboard", module: "tickets" },
  ],
  "knowledge-base": [
    { title: "Write and publish articles", description: "Draft, review and publish knowledge-base content.", href: KNOWLEDGE_BASE_HREF, feature: "knowledge-base.manage", module: "tickets" },
  ],
  admin: [
    { title: "Company settings & modules", description: "Branding, defaults and which modules are on.", href: "/admin/settings", adminOnly: true },
    { title: "Users & roles", description: "Invite people and control what they can access.", href: "/admin/users", adminOnly: true },
    { title: "Email & storage connections", description: "Connect SMTP sending and file storage.", href: "/admin/integration-secrets", adminOnly: true },
  ],
}

/**
 * Map a pathname to a module key. Handles `/modules/<key>/...`, the knowledge
 * base (nested under tickets), the admin area and the dashboard; falls back to
 * "dashboard" so there is always a context.
 */
export function resolveModuleKey(pathname: string | null | undefined): string {
  const path = (pathname ?? "").split("?")[0]
  if (!path || path === "/" || path.startsWith("/dashboard")) return "dashboard"
  if (path.startsWith("/admin")) return "admin"
  if (path.startsWith(KNOWLEDGE_BASE_HREF)) return "knowledge-base"
  const m = /^\/modules\/([a-z0-9-]+)/.exec(path)
  if (m && HELP_TOPICS[m[1]]) return m[1]
  return "dashboard"
}

export function isKnownModuleKey(v: unknown): v is string {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HELP_TOPICS, v)
}

export function canSeeTopic(t: HelpTopic, access: HelpAccess): boolean {
  if (t.adminOnly && !access.isAdmin) return false
  if (t.module && !access.isModuleEnabled(t.module)) return false
  if (t.feature && !access.isAdmin && !access.hasFeature(t.feature)) return false
  return true
}

/**
 * Help topics for a module, filtered by access. General links are appended
 * (also filtered) and de-duplicated by href.
 */
export function getHelpTopics(moduleKey: string, access: HelpAccess): HelpTopic[] {
  const module = HELP_TOPICS[moduleKey] ?? []
  const seen = new Set<string>()
  const keep = (t: HelpTopic) => {
    if (!canSeeTopic(t, access)) return false
    if (seen.has(t.href)) return false
    seen.add(t.href)
    return true
  }
  return [...module.filter(keep), ...GENERAL_HELP.filter(keep)]
}

/** Whether the help panel should offer knowledge-base search at all. */
export function canSearchKnowledgeBase(access: HelpAccess): boolean {
  return canSeeTopic(GENERAL_HELP[0], access)
}
