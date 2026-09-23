import type { SessionPayload } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import type { QuickCommand } from "@/components/shared/command-palette"

/**
 * the permission-aware command registry that powers the global
 * command palette's non-navigation rows: quick "Create <record>" actions and a
 * handful of high-value "Run action / jump" commands.
 *
 * Everything here is gated server-side against the SAME permission the target
 * screen enforces, so the palette can never advertise a create action or admin
 * destination the viewer cannot actually use ("Only show commands allowed for
 * the user"). Navigation across modules is handled separately by the
 * permission-filtered sidebar nav, which the palette already consumes.
 */

/**
 * Quick-create actions. `feature` is the exact feature slug the record's list
 * page checks before it renders its own "New" button, so a viewer only ever
 * sees a create command they are permitted to perform. Each href deep-links to
 * the list page with `?new=1`, which opens that page's create dialog (see
 * `useNewRecordParam`).
 */
const CREATE_COMMANDS: { label: string; href: string; hint: string; feature: string }[] = [
  { label: "Create lead", href: "/modules/sales/leads?new=1", hint: "Sales", feature: "sales.manage_leads" },
  { label: "Create company", href: "/modules/sales/companies?new=1", hint: "Sales", feature: "sales.manage_companies" },
  { label: "Create quotation", href: "/modules/sales/quotations?new=1", hint: "Sales", feature: "sales.manage_quotations" },
  { label: "Create sales invoice", href: "/modules/finance/sales-invoices?new=1", hint: "Finance", feature: "finance.manage_sales_invoices" },
  { label: "Create client", href: "/modules/clients/clients?new=1", hint: "Clients", feature: "clients.manage_clients" },
]

/**
 * Build the ordered, permission-filtered list of quick commands for a session.
 * Create actions come first (the palette groups them under "Create"), followed
 * by admin/account "actions".
 */
export async function buildWorkspaceCommands(session: SessionPayload): Promise<QuickCommand[]> {
  const can = await getFeatureChecker(session.userId, session.role)
  const isAdmin = session.role === "admin"

  const create: QuickCommand[] = CREATE_COMMANDS.filter((c) => can(c.feature)).map((c) => ({
    label: c.label,
    href: c.href,
    hint: c.hint,
    kind: "create",
  }))

  const actions: QuickCommand[] = [
    ...(isAdmin
      ? ([
          { label: "Manage users", href: "/admin/users", hint: "Administration", kind: "action" },
          { label: "Roles & permissions", href: "/admin/roles", hint: "Administration", kind: "action" },
          { label: "Workspace settings", href: "/admin/settings", hint: "Administration", kind: "action" },
          { label: "Platform console", href: "/platform", hint: "Platform", kind: "action" },
        ] satisfies QuickCommand[])
      : []),
    { label: "My profile", href: "/profile", hint: "Account", kind: "action" },
    { label: "Messages", href: "/modules/messages", hint: "Communication", kind: "action" },
  ]

  return [...create, ...actions]
}
