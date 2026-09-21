import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getFileById } from "@/lib/storage"
import { getScanForFile, scanFileNow, approveFile } from "@/lib/storage/file-scanning"

export const runtime = "nodejs"
export const maxDuration = 60

/** SPEC 34 — one file's security state, plus the rescan / release actions. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const fileId = Number((await params).fileId)
  if (!Number.isInteger(fileId) || fileId <= 0) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const file = await getFileById(fileId)
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 })
  const scan = await getScanForFile(fileId)
  return NextResponse.json({ file, scan })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const fileId = Number((await params).fileId)
  if (!Number.isInteger(fileId) || fileId <= 0) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const action = body?.action

  if (action === "rescan") {
    const record = await scanFileNow(fileId, session.userId)
    if (!record) return NextResponse.json({ error: "File not found" }, { status: 404 })
    return NextResponse.json({ ok: true, scan: record })
  }
  if (action === "release") {
    const result = await approveFile(fileId, { userId: session.userId, role: "admin" })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, scan: result.record })
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
