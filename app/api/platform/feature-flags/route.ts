import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { upsertFeatureFlag, setFeatureFlagEnabled } from "@/lib/platform-console"
import { recordPlatformAudit } from "@/lib/platform-roles"

/**
 * Feature flag management. POST upserts a flag (key/name/rollout),
 * PATCH toggles an existing flag on/off. Platform-staff surface; audited.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    await upsertFeatureFlag({
      key: String(body?.key ?? ""),
      name: String(body?.name ?? ""),
      description: body?.description != null ? String(body.description) : null,
      enabled: Boolean(body?.enabled),
      rollout_percentage: Number(body?.rollout_percentage ?? 0),
    })
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "feature_flag_upsert",
      detail: { key: String(body?.key ?? "") },
    })
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to save flag" }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const key = body?.key ? String(body.key) : ""
  if (!key) return NextResponse.json({ error: "Flag key is required" }, { status: 400 })
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "`enabled` must be a boolean" }, { status: 400 })
  }

  try {
    await setFeatureFlagEnabled(key, body.enabled)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "feature_flag_toggle",
      detail: { key, enabled: body.enabled },
    })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to update flag" }, { status: 400 })
  }
}
