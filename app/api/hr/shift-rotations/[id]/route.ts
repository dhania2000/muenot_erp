import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftRotationSchema,
  getRotationDetail,
  updateRotationHeader,
  setRotationStatus,
  type Actor,
} from "@/lib/hr-shift-rotations"

async function canManage(s: { userId: number; role: "admin" | "employee" }) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.manage_shift_rotations")
}
async function canView(s: { userId: number; role: "admin" | "employee" }) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.view_shift_rotations")
}
async function canOverride(s: { userId: number; role: "admin" | "employee" }) {
  return s.role === "admin" || userHasFeature(s.userId, s.role, "hr.override_shift_rotations")
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  const manage = await canManage(session)
  if (!manage && !(await canView(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const detail = await getRotationDetail(id)
  if (!detail) return NextResponse.json({ error: "Rotation not found." }, { status: 404 })

  return NextResponse.json({ ...detail, canManage: manage, canOverride: await canOverride(session) })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canManage(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()
  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }

  // Status toggle takes precedence when present.
  if (body.status === "Active" || body.status === "Inactive") {
    const ok = await setRotationStatus(id, body.status, actor)
    if (!ok) return NextResponse.json({ error: "Rotation not found." }, { status: 404 })
    return NextResponse.json({ ok: true })
  }

  const result = await updateRotationHeader(
    id,
    {
      rotation_name: body.rotation_name !== undefined ? String(body.rotation_name).slice(0, 120) : undefined,
      description: body.description !== undefined ? (body.description ? String(body.description).slice(0, 500) : null) : undefined,
      effective_until: body.effective_until !== undefined ? (body.effective_until ? String(body.effective_until).slice(0, 10) : null) : undefined,
      time_zone: body.time_zone !== undefined ? String(body.time_zone).slice(0, 64) : undefined,
    },
    actor,
  )
  if (!result.ok) return NextResponse.json({ error: result.errors?.[0] || "Update failed", errors: result.errors }, { status: 422 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  if (!(await canManage(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  // Rotations are never hard-deleted (history preservation) — they are deactivated.
  const ok = await setRotationStatus(id, "Inactive", actor)
  if (!ok) return NextResponse.json({ error: "Rotation not found." }, { status: 404 })
  return NextResponse.json({ ok: true })
}
