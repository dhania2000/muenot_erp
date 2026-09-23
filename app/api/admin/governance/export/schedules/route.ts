import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { createExportSchedule, listExportSchedules } from "@/lib/data-export-store"

// SPEC 73 — scheduled (recurring) tenant exports. Tenant-admin only.

export const runtime = "nodejs"

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const schedules = await listExportSchedules(tenantId)
  return NextResponse.json({ schedules })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const actor = {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  }
  const body = await request.json().catch(() => ({}))
  const datasetKey = String(body?.datasetKey ?? "").trim()
  if (!datasetKey) return NextResponse.json({ error: "A dataset or full-tenant scope is required" }, { status: 400 })
  try {
    const schedule = await createExportSchedule(
      tenantId,
      { datasetKey, format: body?.format, frequency: body?.frequency },
      actor,
    )
    return NextResponse.json({ schedule }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
