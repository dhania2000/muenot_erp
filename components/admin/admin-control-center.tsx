import Link from "next/link"
import {
  Activity,
  BadgeCheck,
  Building2,
  ChevronRight,
  CreditCard,
  HardDrive,
  ShieldCheck,
  Workflow,
} from "lucide-react"

type ControlArea = {
  title: string
  description: string
  href: string
  links: { label: string; href: string }[]
  icon: typeof ShieldCheck
}

// This is intentionally a navigation surface only. Each destination is the
// existing, tenant-scoped implementation; no settings or records are copied
// into a second admin dashboard.
const CONTROL_AREAS: ControlArea[] = [
  {
    title: "Access & governance",
    description: "Manage users, access boundaries, approvals and conflicting duties.",
    href: "/admin/users",
    icon: ShieldCheck,
    links: [
      { label: "Roles & permissions", href: "/admin/roles" },
      { label: "Data permissions", href: "/admin/data-permissions" },
      { label: "Approval authority", href: "/admin/approval-authority" },
      { label: "Maker-checker", href: "/admin/maker-checker" },
      { label: "Segregation of duties", href: "/admin/sod" },
    ],
  },
  {
    title: "Organization & people",
    description: "Maintain the hierarchy, legal entities and employee-to-user access links.",
    href: "/modules/organization",
    icon: Building2,
    links: [
      { label: "Organization hierarchy", href: "/modules/organization" },
      { label: "Legal entities", href: "/modules/finance/legal-entities" },
      { label: "Employee links", href: "/admin/employee-links" },
      { label: "Tenant settings", href: "/admin/settings" },
    ],
  },
  {
    title: "Subscription & billing",
    description: "Use the shared tenant billing workspace for plans, usage, invoices and renewals.",
    href: "/modules/billing",
    icon: CreditCard,
    links: [
      { label: "Subscriptions", href: "/modules/billing/subscriptions" },
      { label: "Feature entitlements", href: "/modules/billing/entitlements" },
      { label: "Usage metering", href: "/modules/billing/usage-metering" },
      { label: "Invoices", href: "/modules/billing/invoices" },
    ],
  },
  {
    title: "Storage & retention",
    description: "Configure the existing tenant storage connection, health checks, versions and retention rules.",
    href: "/modules/storage",
    icon: HardDrive,
    links: [
      { label: "Storage connections", href: "/modules/storage" },
      { label: "Large uploads", href: "/modules/storage#large-uploads" },
      { label: "File versions", href: "/modules/storage#file-versions" },
      { label: "Retention policies", href: "/modules/storage#retention" },
    ],
  },
  {
    title: "Workflow & automation",
    description: "Build approvals and automations on the shared event, workflow and notification engines.",
    href: "/admin/automation",
    icon: Workflow,
    links: [
      { label: "Workflow designer", href: "/admin/workflows" },
      { label: "Event monitor", href: "/admin/automation/events" },
      { label: "Notification engine", href: "/admin/automation/notifications" },
      { label: "Email automation", href: "/admin/automation/email" },
    ],
  },
  {
    title: "Operational visibility",
    description: "Review tenant-scoped job health, alerts and execution history without exposing platform operations.",
    href: "/admin/job-monitoring",
    icon: Activity,
    links: [
      { label: "Job monitoring", href: "/admin/job-monitoring" },
      { label: "Admin settings", href: "/admin/settings" },
      { label: "Audit log", href: "/admin/governance" },
      { label: "Risk & compliance", href: "/admin/risk-compliance" },
      { label: "Notification preferences", href: "/notifications/preferences" },
    ],
  },
]

export function AdminControlCenter() {
  return (
    <section className="mx-auto w-full max-w-7xl px-4 pt-6 md:px-6 lg:px-8" aria-labelledby="admin-control-center-title">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-primary">
            <BadgeCheck className="size-5" aria-hidden="true" />
            <span className="text-sm font-medium">Administration</span>
          </div>
          <h1 id="admin-control-center-title" className="text-2xl font-semibold tracking-tight text-foreground">
            Tenant control center
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Configuration is organized by responsibility. Each link opens the existing tenant-scoped screen; platform-wide
            operations remain in the separate Platform Console.
          </p>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {CONTROL_AREAS.map((area) => {
            const Icon = area.icon
            return (
              <article key={area.title} className="flex flex-col rounded-lg border border-border bg-background p-4">
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <Link href={area.href} className="font-semibold text-foreground hover:text-primary hover:underline">
                      {area.title}
                    </Link>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">{area.description}</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-x-3 gap-y-2 border-t border-border pt-3">
                  {area.links.map((link) => (
                    <Link key={link.href} href={link.href} className="inline-flex items-center text-xs font-medium text-primary hover:underline">
                      {link.label} <ChevronRight className="size-3" aria-hidden="true" />
                    </Link>
                  ))}
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
