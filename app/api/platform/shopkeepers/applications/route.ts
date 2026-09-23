import { NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { listApplications } from "@/lib/shopkeeper-applications"

export const dynamic = "force-dynamic"
export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  return NextResponse.json({ applications: await listApplications() }, { headers: { "Cache-Control": "no-store" } })
}
