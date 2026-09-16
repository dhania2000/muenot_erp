import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { readRecruitmentAudit } from "@/lib/recruit-audit"

/**
 * Phase 55 — Recruitment audit trail reader.
 *
 * GET /api/recruitment/audit?module=<moduleKey>&recordId=<businessId>&limit=<n>
 *
 * Returns the change history (create / update / delete) recorded by the shared
 * Recruitment CRUD factory, newest-first. `module` is required; `recordId`
 * narrows it to a single record's timeline.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const p = req.nextUrl.searchParams
  const module = p.get("module")
  if (!module) return NextResponse.json({ error: "module is required" }, { status: 400 })

  try {
    const rows = await readRecruitmentAudit({
      module,
      recordId: p.get("recordId"),
      limit: Number(p.get("limit")) || 100,
    })
    return NextResponse.json({ rows })
  } catch (e) {
    console.error("[recruit-audit] read failed", e)
    return NextResponse.json({ error: "Unable to load audit history" }, { status: 500 })
  }
}
