import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { setConfigValue } from "@/lib/platform-console"
import { recordPlatformAudit } from "@/lib/platform-roles"

/**
 * Platform configuration. Editing platform-wide settings is
 * super-admin only and audited. Unknown keys are rejected by setConfigValue so
 * the config surface stays a fixed, reviewed set rather than arbitrary storage.
 */
export async function PATCH(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const key = body?.key ? String(body.key) : ""
  if (!key) return NextResponse.json({ error: "Config key is required" }, { status: 400 })
  const value = body?.value != null ? String(body.value) : ""

  try {
    await setConfigValue(key, value)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "config_change",
      detail: { key },
    })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to update configuration" }, { status: 400 })
  }
}
