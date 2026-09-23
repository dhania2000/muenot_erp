import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { beginLargeUpload } from "@/lib/storage"
import { listActiveSessions } from "@/lib/storage/multipart-store"

export const runtime = "nodejs"

/**
 * Resumable large-upload sessions.
 * GET  → the current tenant's active (resumable) sessions.
 * POST → open a new multipart session from declared file metadata.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const sessions = await listActiveSessions()
  return NextResponse.json({ sessions })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const filename = String(body.filename ?? "").trim()
  const size = Number(body.size)
  const contentType = body.contentType != null ? String(body.contentType) : null
  const category = body.category != null ? String(body.category) : "other"
  // A stable folder within the tenant namespace; defaults per category.
  const path = String(body.path ?? `large-uploads/${category}`).trim() || `large-uploads/${category}`

  const result = await beginLargeUpload({
    path,
    filename,
    size,
    contentType,
    category,
    userId: session.userId,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  return NextResponse.json(
    { session: result.session, partSize: result.partSize, totalParts: result.totalParts },
    { status: 201 },
  )
}
