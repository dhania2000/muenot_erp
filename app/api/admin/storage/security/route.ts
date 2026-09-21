import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { listFileMetadata } from "@/lib/storage"
import { listScans } from "@/lib/storage/file-scanning"

export const runtime = "nodejs"

/**
 * SPEC 34 — File security / malware-scan dashboard. Reads the real,
 * already-implemented scan ledger (lib/storage/file-scanning.ts); this route
 * only lists it and rolls up the summary counts.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const quarantinedOnly = req.nextUrl.searchParams.get("quarantinedOnly") === "1"
  try {
    const [scans, totalFiles] = await Promise.all([
      listScans({ quarantinedOnly, limit: 500 }),
      listFileMetadata({ currentOnly: true, limit: 500 }).then((f) => f.length),
    ])
    const summary = {
      totalFiles,
      safe: scans.filter((s) => s.safety === "safe").length,
      pending: scans.filter((s) => s.scanStatus === "pending" || s.scanStatus === "scanning").length,
      quarantined: scans.filter((s) => s.quarantineStatus === "quarantined").length,
      failed: scans.filter((s) => s.scanStatus === "error").length,
    }
    return NextResponse.json({ scans, summary })
  } catch (err) {
    console.error("[v0] security scan list failed:", err)
    return NextResponse.json({ error: "Could not load scan records" }, { status: 500 })
  }
}
