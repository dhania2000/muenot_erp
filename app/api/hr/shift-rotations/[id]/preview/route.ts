import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftRotationSchema, getEffectiveSteps } from "@/lib/hr-shift-rotations"
import { buildPreview } from "@/lib/rotation-ui"

/**
 * Day-by-day preview of a SAVED rotation, using the version effective on the
 * range start, anchored at the rotation's effective_from (or a supplied
 * ?anchor). What admins see here is exactly what the resolver applies.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  const allowed =
    session.role === "admin" ||
    (await userHasFeature(session.userId, session.role, "hr.view_shift_rotations")) ||
    (await userHasFeature(session.userId, session.role, "hr.manage_shift_rotations"))
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const rot = await query<any[]>(`SELECT id, effective_from, cycle_type FROM hr_shift_rotations WHERE rotation_id = ? LIMIT 1`, [id])
  if (!rot[0]) return NextResponse.json({ error: "Rotation not found." }, { status: 404 })

  const sp = new URL(request.url).searchParams
  const anchor = (sp.get("anchor") || String(rot[0].effective_from).slice(0, 10)).slice(0, 10)
  const start = (sp.get("start") || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const days = Math.min(120, Math.max(1, Number(sp.get("days")) || 28))

  const effective = await getEffectiveSteps(Number(rot[0].id), start)
  if (!effective || !effective.steps.length) return NextResponse.json({ days: [], anchor, start })

  const preview = buildPreview(anchor, effective.cycleType, effective.steps, start, days)
  return NextResponse.json({
    anchor,
    start,
    cycleType: effective.cycleType,
    days: preview.map((d) => ({
      date: d.date,
      is_weekly_off: d.step?.is_weekly_off ?? false,
      shift_name: d.step?.is_weekly_off ? "Weekly Off" : d.step?.shift_name ?? "—",
      shift_id: d.step?.shift_id ?? null,
    })),
  })
}
