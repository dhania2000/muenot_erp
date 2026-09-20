import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { automationOverview } from "@/lib/automation/center"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    return NextResponse.json(await automationOverview(effectiveTenantId(guard.ctx)!))
  } catch {
    return NextResponse.json({ error: "Unable to load automation overview" }, { status: 500 })
  }
}
