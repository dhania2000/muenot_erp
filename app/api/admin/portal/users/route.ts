import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import { query } from "@/lib/db"
import { generateTempPassword } from "@/lib/password"
import { createPortalUser, listPortalUsers, setPortalUserStatus } from "@/lib/portal/store"
import { setClientResources } from "@/lib/portal/access"
import { isPortalResource, type PortalResource } from "@/lib/portal/config"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()
  const users = await listPortalUsers(tenantId)
  return NextResponse.json({ users })
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()

  const body = await request.json().catch(() => null)
  const clientId = Number(body?.clientId)
  const name = String(body?.name ?? "").trim()
  const email = String(body?.email ?? "").toLowerCase().trim()
  const resources: PortalResource[] = Array.isArray(body?.resources)
    ? body.resources.filter((r: unknown): r is PortalResource => typeof r === "string" && isPortalResource(r))
    : []
  if (!clientId || !name || !email) {
    return NextResponse.json({ error: "Client, name, and email are required" }, { status: 400 })
  }

  // The client MUST belong to the acting tenant. This is the guard against
  // provisioning a portal login for another tenant's client.
  const client = await query<{ id: number }[]>(
    `SELECT id FROM clients WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [clientId, tenantId],
  )
  if (!client[0]) return NextResponse.json({ error: "Client not found" }, { status: 404 })

  const tempPassword = generateTempPassword()
  const user = await createPortalUser({ tenantId, clientId, email, name, password: tempPassword })
  if (resources.length > 0) await setClientResources(tenantId, clientId, resources)

  return NextResponse.json({ user, tempPassword }, { status: 201 })
}

export async function PATCH(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = requireCurrentTenantId()
  const body = await request.json().catch(() => null)
  const userId = Number(body?.userId)
  const status = body?.status
  if (!userId || (status !== "active" && status !== "disabled")) {
    return NextResponse.json({ error: "userId and a valid status are required" }, { status: 400 })
  }
  await setPortalUserStatus(tenantId, userId, status)
  return NextResponse.json({ ok: true })
}
