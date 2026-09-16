import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getInterviewById, updateInterview, deleteInterview } from "@/lib/recruit-db"
import { canActOnRecord, canActOnRecordAction } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"
import { syncInterviewStatus } from "@/lib/recruit-status-sync"
import { query } from "@/lib/db"
import { ensureEmployeeRefColumns, resolvePersonField } from "@/lib/recruit-employee-resolve"

const PERMISSION_KEY = "recruitment.interviews"
const AUDIT_MODULE = "recruit-interviews"

const CANCEL_STATUSES = new Set(["cancelled", "canceled"])
const OUTCOME_STATUSES = new Set([
  "completed",
  "selected",
  "rejected",
  "passed",
  "failed",
  "no show",
  "no-show",
  "noshow",
])

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const existing = await getInterviewById(id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json()

  // Phase 53: carve the scheduling lifecycle out of the generic Update verb.
  // A cancel / reschedule / outcome each need their own separately-grantable
  // permission, so a plain Update can neither cancel, move, nor decide an
  // interview. Unconfigured / admin accounts fall through to full access.
  const oldStatus = String(existing.status ?? "").trim().toLowerCase()
  const newStatus = String(body.status ?? existing.status ?? "").trim().toLowerCase()
  const scheduleChanged =
    body.scheduled_at != null && String(body.scheduled_at) !== String(existing.scheduled_at ?? "")

  let extraAction: string | null = null
  if (CANCEL_STATUSES.has(newStatus) && !CANCEL_STATUSES.has(oldStatus)) extraAction = "cancel_interview"
  else if (scheduleChanged && !CANCEL_STATUSES.has(newStatus)) extraAction = "reschedule_interview"
  else if (OUTCOME_STATUSES.has(newStatus) && newStatus !== oldStatus) extraAction = "record_outcome"

  if (extraAction) {
    if (!(await canActOnRecordAction(session, PERMISSION_KEY, extraAction, existing))) {
      const label =
        extraAction === "cancel_interview"
          ? "cancel"
          : extraAction === "reschedule_interview"
            ? "reschedule"
            : "record an outcome for"
      return NextResponse.json(
        { error: `You do not have permission to ${label} this interview` },
        { status: 403 },
      )
    }
  } else if (!(await canActOnRecord(session, PERMISSION_KEY, "update", existing))) {
    return NextResponse.json({ error: "You do not have permission to edit this interview" }, { status: 403 })
  }

  // Phase 59: re-resolve the interviewer against the Employee Master, store the
  // stable id and derive the canonical name.
  let interviewerEmployeeId: string | null = null
  if (body.interviewer != null && String(body.interviewer).trim()) {
    const ref = await resolvePersonField(body.interviewer)
    if (ref.name) body.interviewer = ref.name
    interviewerEmployeeId = ref.employeeId
  }

  await updateInterview(id, body)

  if (interviewerEmployeeId) {
    try {
      await ensureEmployeeRefColumns("recruit_interviews", ["interviewer_employee_id"])
      await query("UPDATE recruit_interviews SET interviewer_employee_id = ? WHERE interview_id = ?", [
        interviewerEmployeeId,
        id,
      ])
    } catch {
      // best-effort
    }
  }

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

  // Phase 57: reconcile the legacy interview's Google Calendar event +
  // notifications on cancel / reschedule. Best-effort.
  if (extraAction === "cancel_interview" || extraAction === "reschedule_interview") {
    try {
      const { syncLegacyInterviewLifecycle } = await import("@/lib/recruit-legacy-interview-sync")
      await syncLegacyInterviewLifecycle({
        record: after ?? { ...existing, ...body, interview_id: id },
        existing,
        actorId: session.userId,
        kind: extraAction === "cancel_interview" ? "cancel" : "reschedule",
      })
    } catch (e) {
      console.error("[legacy-interview-sync] update sync failed", e)
    }
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

  // Phase 57: deleting an interview must also withdraw its live calendar invite
  // and notify participants — do it BEFORE the row is gone. Best-effort.
  if (existing.calendar_event_id) {
    try {
      const { syncLegacyInterviewLifecycle } = await import("@/lib/recruit-legacy-interview-sync")
      await syncLegacyInterviewLifecycle({
        record: existing,
        existing,
        actorId: session.userId,
        kind: "cancel",
      })
    } catch (e) {
      console.error("[legacy-interview-sync] delete sync failed", e)
    }
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
