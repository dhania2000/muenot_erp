import { NextResponse } from "next/server"
import { effectiveTenantId, requirePlatformSuperAdmin, requireTenantAdmin } from "@/lib/platform-guard"
import { readJobMonitor } from "@/lib/job-monitoring"

export async function jobMonitorResponse(request: Request, audience: "platform" | "tenant") {
  const guard = audience === "platform" ? await requirePlatformSuperAdmin() : await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = audience === "tenant" ? effectiveTenantId(guard.ctx) : null
  if (audience === "tenant" && (!tenantId || tenantId < 1)) return NextResponse.json({ error: "Tenant required" }, { status: 403 })
  const page = Number(new URL(request.url).searchParams.get("page") ?? 1)
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) return NextResponse.json({ error: "Invalid page" }, { status: 400 })
  try {
    const result = await readJobMonitor(audience === "platform" ? { kind: "platform" } : { kind: "tenant", tenantId: tenantId! }, page)
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } })
  } catch {
    return NextResponse.json({ error: "Job monitoring is temporarily unavailable" }, { status: 503 })
  }
}
