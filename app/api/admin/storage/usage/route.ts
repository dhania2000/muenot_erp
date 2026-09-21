import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getStorageQuotaDashboard, setQuotaSettings } from "@/lib/storage"

export const runtime = "nodejs"

/** SPEC 35 — storage usage & quota dashboard (already fully modeled). */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  try {
    const dashboard = await getStorageQuotaDashboard()
    return NextResponse.json(dashboard)
  } catch (err) {
    console.error("[v0] storage quota dashboard failed:", err)
    return NextResponse.json({ error: "Could not load storage usage" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  try {
    await setQuotaSettings({
      customQuotaGb: body?.customQuotaGb === "" ? null : body?.customQuotaGb ?? undefined,
      warnThresholdPercent: body?.warnThresholdPercent,
      hardLimit: body?.hardLimit,
      enforced: body?.enforced,
    })
    const dashboard = await getStorageQuotaDashboard()
    return NextResponse.json(dashboard)
  } catch (err) {
    console.error("[v0] storage quota save failed:", err)
    return NextResponse.json({ error: "Could not save quota settings" }, { status: 500 })
  }
}
