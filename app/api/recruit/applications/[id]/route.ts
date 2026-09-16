import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  getApplicationById,
  updateApplication,
  updateApplicationStage,
  deleteApplication,
} from "@/lib/recruit-db"
import { canActOnRecord } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"
import { syncApplicationStatus } from "@/lib/recruit-status-sync"

const PERMISSION_KEY = "recruitment.candidates"
const AUDIT_MODULE = "recruit-applications"

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const existing = await getApplicationById(id)
  if (!existing) return NextResponse.json({ error: "Application not found" }, { status: 404 })
  // Phase 53/54: gate the update on the record-level scope.
  if (!(await canActOnRecord(session, PERMISSION_KEY, "update", existing))) {
    return NextResponse.json({ error: "You do not have permission to edit this application" }, { status: 403 })
  }

  const body = await request.json()
  const isStageOnly = body.stage && Object.keys(body).length === 1
  if (isStageOnly) {
    await updateApplicationStage(id, body.stage)
  } else {
    await updateApplication(id, body)
  }

  const after = await getApplicationById(id)
  // Phase 55: audit trail.
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_applications",
    recordId: id,
    action: "update",
    userId: session.userId,
    userName: session.name,
    oldValue: existing,
    newValue: after ?? body,
  })

  // Phase 56: propagate a stage change onto interviews, offers, the Candidate
  // Master and the Requisition -> Job headcount.
  if (body.stage && String(existing.stage) !== String(after?.stage ?? body.stage)) {
    await syncApplicationStatus({
      applicationId: id,
      stage: after?.stage ?? body.stage,
      actor: { actorId: session.userId, actorName: session.name },
    })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const existing = await getApplicationById(id)
  if (!existing) return NextResponse.json({ error: "Application not found" }, { status: 404 })
  if (!(await canActOnRecord(session, PERMISSION_KEY, "delete", existing))) {
    return NextResponse.json({ error: "You do not have permission to delete this application" }, { status: 403 })
  }

  await deleteApplication(id)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_applications",
    recordId: id,
    action: "delete",
    userId: session.userId,
    userName: session.name,
    oldValue: existing,
  })
  return NextResponse.json({ ok: true })
}
