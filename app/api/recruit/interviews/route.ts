import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listInterviews, createInterview, getInterviewById } from "@/lib/recruit-db"
import { canCreateInModule, canPerformAction, scopeWhereForModule } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"
import { query } from "@/lib/db"
import { ensureEmployeeRefColumns, resolvePersonField } from "@/lib/recruit-employee-resolve"

const PERMISSION_KEY = "recruitment.interviews"
const AUDIT_MODULE = "recruit-interviews"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const scoped = await scopeWhereForModule(session, PERMISSION_KEY, "view", "recruit_interviews")
  const interviews = await listInterviews(scoped)
  return NextResponse.json({ interviews })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to add interviews" }, { status: 403 })
  }
  // Phase 53: scheduling an interview (which issues calendar invites / pings) is
  // gated separately from a plain Add. Unconfigured / admin accounts pass.
  if (!(await canPerformAction(session, PERMISSION_KEY, "schedule_interview"))) {
    return NextResponse.json({ error: "You do not have permission to schedule interviews" }, { status: 403 })
  }
  const body = await request.json()
  if (!body.candidate_name?.trim()) return NextResponse.json({ error: "Candidate is required" }, { status: 400 })

  // Phase 59: resolve the interviewer against the Employee Master and store a
  // stable employee id; the name is derived from the matched record.
  let interviewerEmployeeId: string | null = null
  if (body.interviewer != null && String(body.interviewer).trim()) {
    const ref = await resolvePersonField(body.interviewer)
    if (ref.name) body.interviewer = ref.name
    interviewerEmployeeId = ref.employeeId
  }

  const result = await createInterview(body, session.userId)
  const interviewId = (result as any)?.interview_id ?? null

  if (interviewId && interviewerEmployeeId) {
    try {
      await ensureEmployeeRefColumns("recruit_interviews", ["interviewer_employee_id"])
      await query("UPDATE recruit_interviews SET interviewer_employee_id = ? WHERE interview_id = ?", [
        interviewerEmployeeId,
        interviewId,
      ])
    } catch {
      // best-effort — the free-text interviewer name is already stored.
    }
  }

  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_interviews",
    recordId: interviewId ?? (result as any)?.id ?? null,
    action: "create",
    userId: session.userId,
    userName: session.name,
    newValue: { ...body, interview_id: interviewId },
  })

  // Phase 57: keep the legacy interview's calendar event + notifications in step
  // on schedule. Best-effort — a sync failure never blocks the create.
  if (interviewId) {
    try {
      const after = await getInterviewById(interviewId)
      if (after) {
        const { syncLegacyInterviewLifecycle } = await import("@/lib/recruit-legacy-interview-sync")
        await syncLegacyInterviewLifecycle({
          record: after,
          existing: null,
          actorId: session.userId,
          kind: "schedule",
        })
      }
    } catch (e) {
      console.error("[legacy-interview-sync] create sync failed", e)
    }
  }

  return NextResponse.json(result, { status: 201 })
}
