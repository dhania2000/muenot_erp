import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { resolveRoleContext } from "@/lib/platform-roles"
import { getModuleBySlug } from "@/lib/custom-modules/store"
import { listMerges, mergeRecords, previewMerge } from "@/lib/custom-modules/merge-service"
import type { MergeSelections } from "@/lib/custom-modules/merge"

export const dynamic = "force-dynamic"

async function requireContext() {
  const session = await getSession()
  if (!session) return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  const roleCtx = await resolveRoleContext(session)
  if (!roleCtx) return null
  return { session, role: roleCtx.tenantRole }
}

function toIdList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
}

/** GET — the module's merge history. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ctx = await requireContext()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const module = await getModuleBySlug((await params).slug)
  if (!module) return NextResponse.json({ error: "Module not found." }, { status: 404 })

  const merges = await listMerges(module.id!)
  return NextResponse.json({ merges })
}

/**
 * POST — preview or execute a merge.
 * Body: { primaryId, secondaryIds, selections, dryRun }. When dryRun is true
 * the survivor is computed and returned WITHOUT any write.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ctx = await requireContext()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const module = await getModuleBySlug((await params).slug)
  if (!module) return NextResponse.json({ error: "Module not found." }, { status: 404 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "A merge request is required." }, { status: 400 })
  }

  const primaryId = Number((body as any).primaryId)
  const secondaryIds = toIdList((body as any).secondaryIds)
  const selections = ((body as any).selections ?? {}) as MergeSelections
  const dryRun = (body as any).dryRun === true

  if (dryRun) {
    const result = await previewMerge(module.id!, primaryId, secondaryIds, selections, ctx.role)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ preview: result.preview })
  }

  const result = await mergeRecords(module.id!, primaryId, secondaryIds, selections, ctx.role, ctx.session.userId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ mergeId: result.mergeId, record: result.record }, { status: 200 })
}
