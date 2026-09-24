import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { query } from "@/lib/db"
import { getClientResources, setClientResources } from "@/lib/portal/access"
import { isPortalResource, type PortalResource } from "@/lib/portal/config"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

async function assertClientInTenant(clientId: number, tenantId: number) {
  const rows = await query<{ id: number }[]>(`SELECT id FROM clients WHERE id = ? AND tenant_id = ? LIMIT 1`, [
    clientId,
    tenantId,
  ])
  return Boolean(rows[0])
}

export async function GET(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()
  const clientId = Number(new URL(request.url).searchParams.get("clientId"))
  if (!clientId || !(await assertClientInTenant(clientId, tenantId))) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 })
  }
  const resources = await getClientResources(tenantId, clientId)
  return NextResponse.json({ resources })
}

export async function PUT(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()
  const body = await request.json().catch(() => null)
  const clientId = Number(body?.clientId)
  const resources: PortalResource[] = Array.isArray(body?.resources)
    ? body.resources.filter((r: unknown): r is PortalResource => typeof r === "string" && isPortalResource(r))
    : []
  if (!clientId || !(await assertClientInTenant(clientId, tenantId))) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 })
  }
  await setClientResources(tenantId, clientId, resources)
  return NextResponse.json({ resources: await getClientResources(tenantId, clientId) })
}
