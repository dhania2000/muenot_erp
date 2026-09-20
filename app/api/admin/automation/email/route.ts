import { NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { emailCenter } from "@/lib/automation/center"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const sp = new URL(request.url).searchParams
  try {
    return NextResponse.json(
      await emailCenter({
        module: sp.get("module") ?? undefined,
        status: sp.get("status") ?? undefined,
        from: sp.get("from") ?? undefined,
        to: sp.get("to") ?? undefined,
        search: sp.get("search")?.trim() || undefined,
      }),
    )
  } catch {
    return NextResponse.json({ error: "Unable to load email activity" }, { status: 500 })
  }
}
