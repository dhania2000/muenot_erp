import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { resolveRoleContext } from "@/lib/platform-roles"
import { getModuleBySlug } from "@/lib/custom-modules/store"
import { rollbackMerge } from "@/lib/custom-modules/merge-service"

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

function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** POST — roll a completed merge back from its stored snapshot. */
export async function POST(_request: Request, { params }: { params: Promise<{ slug: string; mergeId: string }> }) {
  const ctx = await requireContext()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { slug, mergeId } = await params
  const id = parseId(mergeId)
  if (!id) return NextResponse.json({ error: "Invalid merge id." }, { status: 400 })

  const module = await getModuleBySlug(slug)
  if (!module) return NextResponse.json({ error: "Module not found." }, { status: 404 })

  const result = await rollbackMerge(module.id!, id, ctx.role, ctx.session.userId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true })
}
