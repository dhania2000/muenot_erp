import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { validateTenantJobInput, nextRunTimes } from "@/lib/tenant-jobs/model"

/**
 * Spec12 (#22-29). Live "next runs" preview for the schedule form.
 *
 * Validates the candidate schedule server-side (same validator the write path
 * uses) and returns the next few UTC instants honouring the tenant timezone and
 * start/end window. This is what makes DST transitions visible in the UI before
 * saving. No writes, no data leaves the tenant scope.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  if (effectiveTenantId(guard.ctx) == null) return NextResponse.json({ error: "No tenant in context." }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body." }, { status: 400 })

  const parsed = validateTenantJobInput(body)
  if (!parsed.ok) return NextResponse.json({ ok: false, fieldErrors: parsed.errors }, { status: 200 })

  const v = parsed.value
  const from = v.startAt && v.startAt > new Date() ? new Date(v.startAt.getTime() - 1000) : new Date()
  const runs = nextRunTimes(v.cronExpression, v.timezone, from, 5, { startAt: v.startAt, endAt: v.endAt })
  return NextResponse.json({ ok: true, nextRuns: runs.map((d) => d.toISOString()) })
}
