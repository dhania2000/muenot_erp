import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { restoreFileVersion } from "@/lib/storage"

export const runtime = "nodejs"

/**
 * SPEC 33 — Restore a historical version. The version's stored bytes are copied
 * to a fresh key and recorded as a new current version (nothing is overwritten).
 * Permission (admin, or the file's own uploader) is enforced in the service.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const { id } = await params
  const versionId = Number(id)
  if (!Number.isInteger(versionId) || versionId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const result = await restoreFileVersion(versionId, { userId: session.userId, role: session.role })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ version: result.version, restoredFrom: result.restoredFrom })
}
