import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { bulkApplicationAction, type BulkApplicationAction } from "@/lib/recruit-unification-db"

const ALLOWED: BulkApplicationAction[] = ["shortlist", "reject", "hold", "advance"]

/**
 * Phase 13 — shortlisting actions on real Application records.
 *
 * Body: { action, applicationIds: string[], targetStage?, recruiter? }
 * Operates on the actual recruit_applications rows and, for shortlisting,
 * writes exactly one canonical Screening record per application (no duplicates).
 */
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const action = String(body.action || "").trim() as BulkApplicationAction
  if (!ALLOWED.includes(action)) {
    return NextResponse.json({ error: `Unsupported action. Use one of: ${ALLOWED.join(", ")}` }, { status: 400 })
  }

  const applicationIds: string[] = Array.isArray(body.applicationIds)
    ? body.applicationIds
    : body.applicationId
      ? [body.applicationId]
      : []
  if (applicationIds.length === 0) {
    return NextResponse.json({ error: "At least one application id is required" }, { status: 400 })
  }
  if (action === "advance" && !body.targetStage) {
    return NextResponse.json({ error: "targetStage is required for the advance action" }, { status: 400 })
  }

  const result = await bulkApplicationAction(action, applicationIds, {
    targetStage: body.targetStage,
    recruiter: body.recruiter ?? session.name ?? null,
    userId: session.userId,
  })

  return NextResponse.json({ ok: true, ...result })
}
