import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { automationEvents, automationEventDetail } from "@/lib/automation/center"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenant = effectiveTenantId(guard.ctx)!
  const sp = new URL(request.url).searchParams
  try {
    const runId = sp.get("runId")
    if (runId && /^\d+$/.test(runId)) {
      const detail = await automationEventDetail(tenant, Number(runId))
      if (!detail) return NextResponse.json({ error: "Event not found" }, { status: 404 })
      return NextResponse.json(detail)
    }
    return NextResponse.json(
      await automationEvents(tenant, {
        module: sp.get("module") ?? undefined,
        status: sp.get("status") ?? undefined,
        from: sp.get("from") ?? undefined,
        to: sp.get("to") ?? undefined,
        search: sp.get("search")?.trim() || undefined,
      }),
    )
  } catch {
    return NextResponse.json({ error: "Unable to load events. Check database migrations." }, { status: 500 })
  }
}
