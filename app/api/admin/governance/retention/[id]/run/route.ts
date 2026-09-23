import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getPolicy, listRuns, runPolicy } from "@/lib/retention-engine"

// SPEC 71 — on-demand execution of a retention policy. Tenant-admin only.
// Pass { dryRun: true } to preview the number of eligible records without
// archiving or deleting anything.

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const policyId = Number(id)
  const body = await request.json().catch(() => ({}))
  const dryRun = Boolean(body?.dryRun)

  const policy = await getPolicy(tenantId, policyId)
  if (!policy) return NextResponse.json({ error: "Not found" }, { status: 404 })

  try {
    const outcome = await runPolicy(tenantId, policyId, {
      trigger: "manual",
      dryRun,
      actor: {
        userId: guard.session.userId,
        name: guard.session.name,
        email: guard.session.email,
        role: guard.ctx.tenantRole,
      },
    })
    const runs = dryRun ? [] : await listRuns(tenantId, policyId)
    const updated = dryRun ? policy : await getPolicy(tenantId, policyId)
    return NextResponse.json({ outcome, policy: updated, runs })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
