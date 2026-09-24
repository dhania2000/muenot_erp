import type React from "react"
import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { getPortalSession } from "@/lib/portal/auth"
import { getClientResources } from "@/lib/portal/access"
import { query } from "@/lib/db"
import { PortalShell } from "@/components/portal/portal-shell"

async function getClientName(tenantId: number, clientId: number): Promise<string | null> {
  const rows = await query<{ client_name: string | null; company_name: string | null }[]>(
    `SELECT client_name, company_name FROM clients WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [clientId, tenantId],
  ).catch(() => [] as { client_name: string | null; company_name: string | null }[])
  const row = rows[0]
  if (!row) return null
  return row.company_name || row.client_name || null
}

export const dynamic = "force-dynamic"

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  // The login route renders its own bare layout; detect it so we don't wrap it
  // in the authenticated shell.
  const hdrs = await headers()
  const pathname = hdrs.get("x-portal-pathname") ?? hdrs.get("x-pathname") ?? ""
  if (pathname.startsWith("/portal/login")) {
    return <>{children}</>
  }

  const session = await getPortalSession()
  if (!session) redirect("/portal/login")

  const [resources, clientName] = await Promise.all([
    getClientResources(session.tenantId, session.clientId),
    getClientName(session.tenantId, session.clientId),
  ])

  return (
    <PortalShell
      resources={resources}
      user={{ name: session.name, email: session.email }}
      clientName={clientName}
    >
      {children}
    </PortalShell>
  )
}
