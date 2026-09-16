import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listInterviews, createInterview } from "@/lib/recruit-db"
import { canCreateInModule, scopeWhereForModule } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"

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
  const body = await request.json()
  if (!body.candidate_name?.trim()) return NextResponse.json({ error: "Candidate is required" }, { status: 400 })
  const result = await createInterview(body, session.userId)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_interviews",
    recordId: (result as any)?.interview_id ?? (result as any)?.id ?? null,
    action: "create",
    userId: session.userId,
    userName: session.name,
    newValue: { ...body, interview_id: (result as any)?.interview_id },
  })
  return NextResponse.json(result, { status: 201 })
}
