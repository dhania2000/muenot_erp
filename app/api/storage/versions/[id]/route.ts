import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getFileVersionHistory } from "@/lib/storage"

export const runtime = "nodejs"

/**
 * SPEC 33 — Full version history (with uploader + audit trail) for the logical
 * file that version `id` belongs to. Tenant ownership is enforced by the
 * tenant-scoped reads inside getFileVersionHistory.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const { id } = await params
  const versionId = Number(id)
  if (!Number.isInteger(versionId) || versionId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const history = await getFileVersionHistory(versionId)
    if (!history) return NextResponse.json({ error: "File not found" }, { status: 404 })
    return NextResponse.json(history)
  } catch (err) {
    console.error("[v0] version history failed:", err)
    return NextResponse.json({ error: "Could not load version history" }, { status: 500 })
  }
}
