import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import {
  deleteProvider,
  getProviderById,
  setProviderStatus,
  toPublicProvider,
  updateProvider,
  type ProviderInput,
} from "@/lib/sso-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

async function loadScoped(id: number, tenantId: number) {
  const row = await getProviderById(id)
  if (!row || row.tenant_id !== tenantId) return null
  return row
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const row = await loadScoped(Number((await params).id), ctx.tenantId)
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ provider: toPublicProvider(row) })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = Number((await params).id)
  const row = await loadScoped(id, ctx.tenantId)
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = (await request.json().catch(() => null)) as
    | (Partial<ProviderInput> & { status?: "enabled" | "disabled" | "draft" })
    | null
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 })

  if (body.status) {
    if (body.status === "enabled" && !row.client_secret_encrypted && row.type === "oidc" && !body.clientSecret) {
      return NextResponse.json({ error: "Set a client secret before enabling this provider" }, { status: 400 })
    }
    await setProviderStatus(id, body.status)
  }

  const { status, ...rest } = body
  if (Object.keys(rest).length > 0) await updateProvider(id, rest)

  const updated = await getProviderById(id)
  return NextResponse.json({ provider: updated ? toPublicProvider(updated) : null })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = Number((await params).id)
  const row = await loadScoped(id, ctx.tenantId)
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  await deleteProvider(id)
  return NextResponse.json({ ok: true })
}
