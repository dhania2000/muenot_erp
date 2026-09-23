import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { listFileMetadata } from "@/lib/storage"

export const runtime = "nodejs"

/**
 * List the current tenant's versioned files (one row per logical
 * file: the current version). Powers the "Document versions" file picker.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const moduleFilter = req.nextUrl.searchParams.get("module") ?? undefined
  try {
    const files = await listFileMetadata({ currentOnly: true, module: moduleFilter, limit: 200 })
    // Only files anchored to an entity + filename participate in versioning.
    const versioned = files.filter((f) => f.entityType && f.filename)
    return NextResponse.json({ files: versioned })
  } catch (err) {
    console.error("[v0] list versioned files failed:", err)
    return NextResponse.json({ error: "Could not load files" }, { status: 500 })
  }
}
