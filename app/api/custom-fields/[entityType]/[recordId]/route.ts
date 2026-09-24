import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { resolveRoleContext } from "@/lib/platform-roles"
import { buildRecordView, setRecordValues } from "@/lib/custom-fields/service"
import { listActiveDefsForEntity } from "@/lib/custom-fields/store"
import { canViewField } from "@/lib/custom-fields/model"

export const dynamic = "force-dynamic"

/**
 * Any authenticated tenant user may read/write a record's custom values; the
 * engine enforces per-field VIEW/EDIT permissions against the caller's resolved
 * tenant role, so authorization is never trusted from the client.
 */
async function requireRole() {
  const session = await getSession()
  if (!session) return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  const roleCtx = await resolveRoleContext(session)
  if (!roleCtx) return null
  return { session, roleCtx }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entityType: string; recordId: string }> },
) {
  const ctx = await requireRole()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { entityType, recordId } = await params
  // The permission-filtered, formula-computed projection (the reporting surface):
  // fields the role cannot view are omitted entirely, never blanked.
  const fields = await buildRecordView(entityType, recordId, ctx.roleCtx.tenantRole)
  // Definitions the role may see, so a form knows how to render each input.
  const defs = (await listActiveDefsForEntity(entityType)).filter((d) =>
    canViewField(d, ctx.roleCtx.tenantRole),
  )
  return NextResponse.json({ fields, defs, role: ctx.roleCtx.tenantRole })
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ entityType: string; recordId: string }> },
) {
  const ctx = await requireRole()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { entityType, recordId } = await params
  const body = await request.json().catch(() => null)
  const values = body && typeof body === "object" ? (body.values ?? body) : null
  if (!values || typeof values !== "object") {
    return NextResponse.json({ error: "A values object is required." }, { status: 400 })
  }

  const result = await setRecordValues(
    entityType,
    recordId,
    values as Record<string, unknown>,
    ctx.roleCtx.tenantRole,
    ctx.session.userId,
  )
  if (!result.ok) {
    return NextResponse.json({ error: "Some values could not be saved.", errors: result.errors }, { status: 400 })
  }

  // Return the freshly computed view so the caller sees recomputed formulas.
  const fields = await buildRecordView(entityType, recordId, ctx.roleCtx.tenantRole)
  return NextResponse.json({ ok: true, values: result.values, fields })
}
