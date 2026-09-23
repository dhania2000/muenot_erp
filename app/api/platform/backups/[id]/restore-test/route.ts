import { NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { type BackupActor, runRestoreTest } from "@/lib/backup/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const runId = Number(id)
  const tenantIdRaw = req.nextUrl.searchParams.get("tenantId")
  const tenantId = tenantIdRaw && Number(tenantIdRaw) > 0 ? Number(tenantIdRaw) : null
  if (!Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: "A valid backup run id is required" }, { status: 400 })
  }
  const actor: BackupActor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  const test = await runRestoreTest(tenantId, runId, actor)
  if (!test) return NextResponse.json({ error: "Backup run not found" }, { status: 404 })
  return NextResponse.json({ ok: true, restoreTest: test })
}
