import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureOperationsSchema } from "@/lib/operations-ensure"

/**
 * Read-only version history for an SOP (Phase 33). Snapshots are written
 * automatically by the Operations write path (see lib/operations-sync.ts) and
 * are never mutated here — old versions are immutable.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const sopId = Number(new URL(request.url).searchParams.get("sop_id"))
  if (!Number.isFinite(sopId) || sopId <= 0) {
    return NextResponse.json({ error: "Missing sop_id" }, { status: 400 })
  }
  try {
    await ensureOperationsSchema()
    const rows = await query<any[]>(
      `SELECT * FROM operations_sop_versions WHERE sop_id = ? ORDER BY created_at DESC, id DESC`,
      [sopId],
    )
    return NextResponse.json({ rows })
  } catch {
    return NextResponse.json({ error: "Failed to load SOP history" }, { status: 500 })
  }
}
