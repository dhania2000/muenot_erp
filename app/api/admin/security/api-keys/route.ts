import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import {
  AVAILABLE_SCOPES,
  API_KEY_ENVIRONMENTS,
  createApiKey,
  listApiKeys,
  type ApiKeyEnvironment,
} from "@/lib/api-keys-store"
import { ipMatchesCidr } from "@/lib/ip-allowlist-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/** A CIDR (or bare IP) is valid if ipMatchesCidr accepts it against itself. */
function isValidCidr(value: string): boolean {
  const ip = value.split("/")[0]
  return ipMatchesCidr(ip, value)
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const keys = await listApiKeys(ctx.tenantId)
  return NextResponse.json({ keys, availableScopes: AVAILABLE_SCOPES, environments: API_KEY_ENVIRONMENTS })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as {
    name?: string
    scopes?: string[]
    environment?: string
    ipRestrictions?: string[]
    expiresAt?: string | null
  } | null

  if (!body?.name?.trim()) return NextResponse.json({ error: "Key name is required" }, { status: 400 })

  const validScopes = new Set(AVAILABLE_SCOPES.map((s) => s.value))
  const scopes = (body.scopes ?? []).filter((s) => validScopes.has(s as any))
  if (scopes.length === 0) return NextResponse.json({ error: "Select at least one scope" }, { status: 400 })

  const environment: ApiKeyEnvironment = body.environment === "test" ? "test" : "live"

  const ipRestrictions = (body.ipRestrictions ?? []).map((s) => s.trim()).filter(Boolean)
  const invalid = ipRestrictions.filter((cidr) => !isValidCidr(cidr))
  if (invalid.length > 0) {
    return NextResponse.json({ error: `Invalid IP range(s): ${invalid.join(", ")}` }, { status: 400 })
  }

  let expiresAt: string | null = null
  if (body.expiresAt) {
    const ts = new Date(body.expiresAt)
    if (Number.isNaN(ts.getTime())) return NextResponse.json({ error: "Invalid expiration date" }, { status: 400 })
    if (ts.getTime() <= Date.now())
      return NextResponse.json({ error: "Expiration must be in the future" }, { status: 400 })
    expiresAt = ts.toISOString().slice(0, 19).replace("T", " ")
  }

  const { key, plaintext } = await createApiKey(
    ctx.tenantId,
    { name: body.name.trim(), scopes, environment, ipRestrictions, expiresAt },
    ctx.session.userId,
  )
  // The plaintext key is returned exactly once — the server never persists or re-serves it.
  return NextResponse.json({ key, plaintext })
}
