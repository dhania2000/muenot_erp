import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { resolveRoleContext } from "@/lib/platform-roles"
import { getModuleBySlug } from "@/lib/custom-modules/store"
import { deleteRecord, getRecordById, transitionRecord, updateRecord } from "@/lib/custom-modules/service"
import { availableTransitions, canViewModule } from "@/lib/custom-modules/model"

export const dynamic = "force-dynamic"

async function requireContext() {
  const session = await getSession()
  if (!session) return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  const roleCtx = await resolveRoleContext(session)
  if (!roleCtx) return null
  return { session, tenantId: tenant.tenantId, role: roleCtx.tenantRole }
}

function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; recordId: string }> }) {
  const ctx = await requireContext()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { slug, recordId } = await params
  const id = parseId(recordId)
  if (!id) return NextResponse.json({ error: "Invalid record id." }, { status: 400 })

  const module = await getModuleBySlug(slug)
  if (!module) return NextResponse.json({ error: "Module not found." }, { status: 404 })
  if (!canViewModule(module.permissions, ctx.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const record = await getRecordById(module.id!, id)
  if (!record) return NextResponse.json({ error: "Record not found." }, { status: 404 })

  return NextResponse.json({
    module,
    record,
    transitions: availableTransitions(module.workflow, record.state, ctx.role),
  })
}

export async function PUT(request: Request, { params }: { params: Promise<{ slug: string; recordId: string }> }) {
  const ctx = await requireContext()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { slug, recordId } = await params
  const id = parseId(recordId)
  if (!id) return NextResponse.json({ error: "Invalid record id." }, { status: 400 })

  const module = await getModuleBySlug(slug)
  if (!module) return NextResponse.json({ error: "Module not found." }, { status: 404 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Record values are required." }, { status: 400 })
  }

  const result = await updateRecord(
    module.id!,
    id,
    (body.values ?? {}) as Record<string, unknown>,
    body.attachments,
    ctx.role,
    ctx.session.userId,
  )
  if ("errors" in result) {
    return NextResponse.json({ error: "Validation failed.", errors: result.errors }, { status: 400 })
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ record: result.record })
}

/** Move the record through the workflow: body { toState }. */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string; recordId: string }> }) {
  const ctx = await requireContext()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { slug, recordId } = await params
  const id = parseId(recordId)
  if (!id) return NextResponse.json({ error: "Invalid record id." }, { status: 400 })

  const module = await getModuleBySlug(slug)
  if (!module) return NextResponse.json({ error: "Module not found." }, { status: 404 })

  const body = await request.json().catch(() => null)
  const toState = body?.toState
  if (!toState || typeof toState !== "string") {
    return NextResponse.json({ error: "A target state is required." }, { status: 400 })
  }

  const result = await transitionRecord(module.id!, id, toState, ctx.role, ctx.session.userId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ record: result.record })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ slug: string; recordId: string }> }) {
  const ctx = await requireContext()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { slug, recordId } = await params
  const id = parseId(recordId)
  if (!id) return NextResponse.json({ error: "Invalid record id." }, { status: 400 })

  const module = await getModuleBySlug(slug)
  if (!module) return NextResponse.json({ error: "Module not found." }, { status: 404 })

  const result = await deleteRecord(module.id!, id, ctx.role)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true })
}
