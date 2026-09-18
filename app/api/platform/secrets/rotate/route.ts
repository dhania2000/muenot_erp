import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { rotateSecret } from "@/lib/secrets/store"
import { recordPlatformAudit } from "@/lib/platform-roles"

/**
 * SPEC 38 — Secret rotation. Super-admin only. A rotation appends a new
 * encrypted version, retires the previous one, and advances the rotation clock.
 * The new value is provided by the operator (the platform never fabricates key
 * material); the response only confirms the resulting version.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const key = body?.key ? String(body.key) : ""
  const value = body?.value != null ? String(body.value) : ""
  if (!key) return NextResponse.json({ error: "Secret key is required" }, { status: 400 })
  if (!value) return NextResponse.json({ error: "A new secret value is required to rotate" }, { status: 400 })

  try {
    const actor = { userId: guard.ctx.userId, email: guard.session.email }
    const { version } = await rotateSecret(key, value, actor)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "secret_rotate",
      detail: { key, version },
    })
    return NextResponse.json({ ok: true, version })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to rotate secret" }, { status: 400 })
  }
}
