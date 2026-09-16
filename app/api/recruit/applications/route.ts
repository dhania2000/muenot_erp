import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listApplications, createApplication } from "@/lib/recruit-db"
import { canCreateInModule, scopeWhereForModule } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"

const PERMISSION_KEY = "recruitment.candidates"
const AUDIT_MODULE = "recruit-applications"

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const jobId = request.nextUrl.searchParams.get("jobId") || undefined
  // Phase 54: only return the rows this viewer's scope permits.
  const scoped = await scopeWhereForModule(session, PERMISSION_KEY, "view", "recruit_applications")
  const applications = await listApplications(jobId, scoped)
  return NextResponse.json({ applications })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // Phase 53: enforce the Add scope before creating.
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to add applications" }, { status: 403 })
  }
  const body = await request.json()
  if (!body.candidate_name?.trim()) return NextResponse.json({ error: "Candidate name is required" }, { status: 400 })
  const result = await createApplication(body, session.userId)
  // Phase 55: audit trail.
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_applications",
    recordId: (result as any)?.application_id ?? (result as any)?.id ?? null,
    action: "create",
    userId: session.userId,
    userName: session.name,
    newValue: { ...body, application_id: (result as any)?.application_id },
  })
  return NextResponse.json(result, { status: 201 })
}
