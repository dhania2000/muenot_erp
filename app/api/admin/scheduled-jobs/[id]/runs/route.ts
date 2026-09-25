import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getTenantJob, listTenantJobRuns } from "@/lib/tenant-jobs/store"

/**
 * Spec12 (#22-29). Run history for one schedule — success/retry/dead-letter
 * rows with attempts, next retry and error details. Tenant-scoped: a schedule
 * id from another tenant resolves to 404 because getTenantJob filters on it.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context." }, { status: 403 })

  const id = Math.floor(Number((await params).id))
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid schedule id." }, { status: 400 })

  const job = await getTenantJob(tenantId, id)
  if (!job) return NextResponse.json({ error: "Scheduled job not found." }, { status: 404 })

  const limit = Math.min(200, Math.max(1, Math.floor(Number(new URL(request.url).searchParams.get("limit")) || 50)))
  const runs = await listTenantJobRuns(tenantId, id, limit)
  return NextResponse.json({ runs })
}
