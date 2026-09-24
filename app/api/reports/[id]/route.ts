import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { deleteReport, getReport, updateReport, type Actor } from "@/lib/reports/store"

export const runtime = "nodejs"

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
  const { id } = await params
  const report = await getReport(tenantId, Number(id))
  if (!report) return NextResponse.json({ error: "Report not found." }, { status: 404 })
  return NextResponse.json({ report })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 })

  try {
    const report = await updateReport(
      tenantId,
      Number(id),
      { name: body.name, description: body.description, definition: body.definition },
      actorFrom(guard),
    )
    return NextResponse.json({ report })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const removed = await deleteReport(tenantId, Number(id), actorFrom(guard))
  if (!removed) return NextResponse.json({ error: "Report not found." }, { status: 404 })
  return NextResponse.json({ ok: true })
}
