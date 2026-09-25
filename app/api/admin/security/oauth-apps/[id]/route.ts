import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import {
  OAUTH_SCOPES,
  deleteOAuthApp,
  getOAuthApp,
  revokeOAuthApp,
  rotateOAuthAppSecret,
  updateOAuthApp,
} from "@/lib/oauth/oauth-apps-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

/**
 * PATCH performs one lifecycle action on a single app:
 *   - `rotate`  → mint a new client secret (previous stays valid for a grace window)
 *   - `revoke`  → revoke the app and all of its live tokens
 *   - `update`  → adjust name/description/scoped-consent/token TTL
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const appId = Number(id)
  if (!Number.isInteger(appId) || appId <= 0) return NextResponse.json({ error: "Invalid app id" }, { status: 400 })

  const body = (await request.json().catch(() => null)) as {
    action?: string
    graceSeconds?: number
    name?: string
    description?: string | null
    scopes?: string[]
    tokenTtlSeconds?: number
  } | null

  const action = body?.action

  if (action === "rotate") {
    const result = await rotateOAuthAppSecret(ctx.tenantId, appId, ctx.session.userId, {
      graceSeconds: body?.graceSeconds,
    })
    if (!result) return NextResponse.json({ error: "App not found" }, { status: 404 })
    return NextResponse.json({ clientSecret: result.clientSecret, graceSeconds: result.graceSeconds })
  }

  if (action === "revoke") {
    const changed = await revokeOAuthApp(ctx.tenantId, appId, ctx.session.userId)
    if (!changed) return NextResponse.json({ error: "App not found or already revoked" }, { status: 404 })
    return NextResponse.json({ ok: true })
  }

  if (action === "update") {
    let scopes: string[] | undefined
    if (body?.scopes !== undefined) {
      const validScopes = new Set(OAUTH_SCOPES.map((s) => s.value))
      scopes = body.scopes.filter((s) => validScopes.has(s as never))
      if (scopes.length === 0) return NextResponse.json({ error: "Select at least one scope" }, { status: 400 })
    }
    try {
      const changed = await updateOAuthApp(
        ctx.tenantId,
        appId,
        {
          name: body?.name,
          description: body?.description,
          scopes,
          tokenTtlSeconds: body?.tokenTtlSeconds,
        },
        ctx.session.userId,
      )
      const app = await getOAuthApp(ctx.tenantId, appId)
      if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 })
      return NextResponse.json({ ok: changed, app })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update app" }, { status: 400 })
    }
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const appId = Number(id)
  if (!Number.isInteger(appId) || appId <= 0) return NextResponse.json({ error: "Invalid app id" }, { status: 400 })
  await deleteOAuthApp(ctx.tenantId, appId, ctx.session.userId)
  return NextResponse.json({ ok: true })
}
