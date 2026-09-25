import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import {
  OAUTH_SCOPES,
  DEFAULT_TOKEN_TTL_SECONDS,
  MIN_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  DEFAULT_ROTATION_GRACE_SECONDS,
  MAX_ROTATION_GRACE_SECONDS,
  createOAuthApp,
  listOAuthApps,
} from "@/lib/oauth/oauth-apps-store"

/**
 * Tenant developer console — OAuth app registry.
 * Every operation is gated on an admin session AND the resolved tenant; the
 * tenant is taken from server context, never from request input, so a caller
 * can only ever see or mutate its own tenant's apps.
 */
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
  const apps = await listOAuthApps(ctx.tenantId)
  return NextResponse.json({
    apps,
    availableScopes: OAUTH_SCOPES,
    tokenTtl: {
      default: DEFAULT_TOKEN_TTL_SECONDS,
      min: MIN_TOKEN_TTL_SECONDS,
      max: MAX_TOKEN_TTL_SECONDS,
    },
    rotationGrace: {
      default: DEFAULT_ROTATION_GRACE_SECONDS,
      max: MAX_ROTATION_GRACE_SECONDS,
    },
  })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as {
    name?: string
    description?: string | null
    scopes?: string[]
    tokenTtlSeconds?: number
  } | null

  if (!body?.name?.trim()) return NextResponse.json({ error: "App name is required" }, { status: 400 })

  const validScopes = new Set(OAUTH_SCOPES.map((s) => s.value))
  const scopes = (body.scopes ?? []).filter((s) => validScopes.has(s as never))
  if (scopes.length === 0) return NextResponse.json({ error: "Select at least one scope" }, { status: 400 })

  try {
    const { app, clientSecret } = await createOAuthApp(
      ctx.tenantId,
      {
        name: body.name.trim(),
        description: body.description ?? null,
        scopes,
        tokenTtlSeconds: body.tokenTtlSeconds,
      },
      ctx.session.userId,
    )
    // client_id is durable; client_secret is returned exactly once and only a
    // SHA-256 hash is persisted — it can never be re-served.
    return NextResponse.json({ app, clientSecret })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create app" }, { status: 400 })
  }
}
