import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { rollbackImport } from "@/lib/data-import-store"

// SPEC 74 — undo a completed import. Deletes the exact rows the job inserted
// (feasible only when the target table has an auto-increment `id`, captured at
// commit time). Tenant-scoped and audited.

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const actor = {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  }
  const { id } = await params
  const jobId = Number(id)
  if (!Number.isFinite(jobId)) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  try {
    const job = await rollbackImport(tenantId, actor, jobId)
    return NextResponse.json({ job })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
