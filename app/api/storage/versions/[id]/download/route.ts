import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getVersionDownloadUrl } from "@/lib/storage"

export const runtime = "nodejs"

/**
 * Issue a short-lived signed URL to download a specific historical
 * version, and record a "downloaded" audit entry. Returns JSON so the client
 * can open it in a new tab (works whether the app is framed or not).
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

  const result = await getVersionDownloadUrl(versionId, { userId: session.userId })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ url: result.url, filename: result.filename, version: result.version })
}
