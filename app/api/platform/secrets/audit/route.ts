import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { listAccessLog } from "@/lib/secrets/store"

/**
 * Secret access audit. Any platform staff may read the access log
 * (create/update/rotate/clear/access). The log records WHO touched WHICH secret
 * and WHEN — never the value — so it is safe to return in full.
 */
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const url = new URL(req.url)
  const secretKey = url.searchParams.get("key") ?? undefined
  const limitParam = Number(url.searchParams.get("limit"))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined

  try {
    const events = await listAccessLog({ secretKey, limit })
    return NextResponse.json({ events })
  } catch (err) {
    console.error("[v0] secrets audit GET failed", err)
    return NextResponse.json({ error: "Unable to load access log" }, { status: 500 })
  }
}
