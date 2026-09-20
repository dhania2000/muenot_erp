import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { AVAILABLE_SCOPES, createApiKey, listApiKeys } from "@/lib/api-keys-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const keys = await listApiKeys(ctx.tenantId)
  return NextResponse.json({ keys, availableScopes: AVAILABLE_SCOPES })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as { name?: string; scopes?: string[]; expiresAt?: string | null } | null
  if (!body?.name?.trim()) return NextResponse.json({ error: "Key name is required" }, { status: 400 })
  const validScopes = new Set(AVAILABLE_SCOPES.map((s) => s.value))
  const scopes = (body.scopes ?? []).filter((s) => validScopes.has(s as any))
  if (scopes.length === 0) return NextResponse.json({ error: "Select at least one scope" }, { status: 400 })

  const { key, plaintext } = await createApiKey(
    ctx.tenantId,
    { name: body.name.trim(), scopes, expiresAt: body.expiresAt ?? null },
    ctx.session.userId,
  )
  // The plaintext key is returned exactly once — the server never persists or re-serves it.
  return NextResponse.json({ key, plaintext })
}
