import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getInterviewById, updateInterview, deleteInterview } from "@/lib/recruit-db"
import { canActOnRecord } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"
import { syncInterviewStatus } from "@/lib/recruit-status-sync"

const PERMISSION_KEY = "recruitment.interviews"
const AUDIT_MODULE = "recruit-interviews"

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const existing = await getInterviewById(id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!(await canActOnRecord(session, PERMISSION_KEY, "update", existing))) {
    return NextResponse.json({ error: "You do not have permission to edit this interview" }, { status: 403 })
  }

  const body = await request.json()
  await updateInterview(id, body)
  const after = await getInterviewById(id)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_interviews",
    recordId: id,
    action: "update",
    userId: session.userId,
    userName: session.name,
    oldValue: existing,
    newValue: after ?? body,
  })

  // Phase 56: an interview outcome moves the linked application forward.
  if (body.status && String(existing.status) !== String(after?.status ?? body.status)) {
    await syncInterviewStatus({
      interviewId: id,
      status: after?.status ?? body.status,
      actor: { actorId: session.userId, actorName: session.name },
    })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const existing = await getInterviewById(id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!(await canActOnRecord(session, PERMISSION_KEY, "delete", existing))) {
    return NextResponse.json({ error: "You do not have permission to delete this interview" }, { status: 403 })
  }

  await deleteInterview(id)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_interviews",
    recordId: id,
    action: "delete",
    userId: session.userId,
    userName: session.name,
    oldValue: existing,
  })
  return NextResponse.json({ ok: true })
}
