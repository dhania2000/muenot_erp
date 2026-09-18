import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { clearSecret, getSecretsOverview, setSecret } from "@/lib/secrets/store"
import { assertNoPlaintextExposure } from "@/lib/secrets/model"
import { recordPlatformAudit } from "@/lib/platform-roles"

/**
 * SPEC 38 — Secret management API.
 * ---------------------------------------------------------------------------
 * GET returns the MASKED inventory (any platform staff). Writing or clearing a
 * secret is super-admin only and double-audited (secret access log + platform
 * audit). No handler ever returns a plaintext value: the overview is asserted
 * exposure-free before it leaves, and a write only echoes the new version.
 */

export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const secrets = await getSecretsOverview()
    assertNoPlaintextExposure(secrets)
    return NextResponse.json({ secrets })
  } catch (err) {
    console.error("[v0] secrets GET failed", err)
    return NextResponse.json({ error: "Unable to load secrets" }, { status: 500 })
  }
}

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
  if (!value) return NextResponse.json({ error: "Secret value is required" }, { status: 400 })

  try {
    const actor = { userId: guard.ctx.userId, email: guard.session.email }
    const { version } = await setSecret(key, value, actor)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "secret_set",
      detail: { key, version },
    })
    return NextResponse.json({ ok: true, version })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to store secret" }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const key = new URL(req.url).searchParams.get("key") ?? ""
  if (!key) return NextResponse.json({ error: "Secret key is required" }, { status: 400 })

  try {
    const actor = { userId: guard.ctx.userId, email: guard.session.email }
    await clearSecret(key, actor)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "secret_clear",
      detail: { key },
    })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to clear secret" }, { status: 400 })
  }
}
