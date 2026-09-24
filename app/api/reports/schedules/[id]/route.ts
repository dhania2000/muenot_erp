import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { type Actor } from "@/lib/reports/store"
import {
  deleteReportSchedule,
  getReportSchedule,
  listReportScheduleRuns,
  setReportScheduleStatus,
} from "@/lib/reports/scheduler-store"

export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const id = Math.floor(Number(raw))
  return Number.isInteger(id) && id > 0 ? id : null
}

function actorFrom(guard: Extract<Awaited<ReturnType<typeof requireTenantAdmin>>, { ok: true }>): Actor {
  return {
    userId: guard.session.userId,
    name: guard.session.name ?? null,
    email: guard.session.email ?? null,
    role: guard.ctx.tenantRole,
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid schedule id." }, { status: 400 })

  const schedule = await getReportSchedule(tenantId, id)
  if (!schedule) return NextResponse.json({ error: "Schedule not found." }, { status: 404 })
  const runs = await listReportScheduleRuns(tenantId, id, 20)
  return NextResponse.json({ schedule, runs })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid schedule id." }, { status: 400 })

  const body = await request.json().catch(() => null)
  const status = body?.status
  if (status !== "active" && status !== "paused") {
    return NextResponse.json({ error: "status must be 'active' or 'paused'." }, { status: 400 })
  }
  const schedule = await setReportScheduleStatus(tenantId, id, status, actorFrom(guard))
  if (!schedule) return NextResponse.json({ error: "Schedule not found." }, { status: 404 })
  return NextResponse.json({ schedule })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid schedule id." }, { status: 400 })

  const ok = await deleteReportSchedule(tenantId, id, actorFrom(guard))
  if (!ok) return NextResponse.json({ error: "Schedule not found." }, { status: 404 })
  return NextResponse.json({ success: true })
}
