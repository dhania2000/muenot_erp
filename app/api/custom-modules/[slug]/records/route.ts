import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { resolveRoleContext } from "@/lib/platform-roles"
import { getModuleBySlug } from "@/lib/custom-modules/store"
import { createRecord, listRecords } from "@/lib/custom-modules/service"
import { availableTransitions, canCreateRecord, canViewModule } from "@/lib/custom-modules/model"

export const dynamic = "force-dynamic"

/** Resolve the acting session + tenant + tenant role, or null when unauthorized. */
async function requireContext() {
  const session = await getSession()
  if (!session) return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  const roleCtx = await resolveRoleContext(session)
  if (!roleCtx) return null
  return { session, tenantId: tenant.tenantId, role: roleCtx.tenantRole }
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ctx = await requireContext()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const module = await getModuleBySlug((await params).slug)
  if (!module || module.status === "archived") {
    return NextResponse.json({ error: "Module not found." }, { status: 404 })
  }
  if (!canViewModule(module.permissions, ctx.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const url = new URL(request.url)
  const state = url.searchParams.get("state") ?? undefined
  const records = await listRecords(module.id!, state)

  return NextResponse.json({
    module,
    records,
    can: {
      create: canCreateRecord(module.permissions, ctx.role),
    },
    // Per-record next steps the current role may take, keyed by state.
    transitions: module.workflow.enabled
      ? Object.fromEntries(
          module.workflow.states.map((s) => [s.key, availableTransitions(module.workflow, s.key, ctx.role)]),
        )
      : {},
  })
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ctx = await requireContext()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const module = await getModuleBySlug((await params).slug)
  if (!module) return NextResponse.json({ error: "Module not found." }, { status: 404 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Record values are required." }, { status: 400 })
  }

  const result = await createRecord(
    module.id!,
    (body.values ?? {}) as Record<string, unknown>,
    body.attachments,
    ctx.role,
    ctx.session.userId,
  )
  if ("errors" in result) {
    return NextResponse.json({ error: "Validation failed.", errors: result.errors }, { status: 400 })
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ record: result.record }, { status: 201 })
}
