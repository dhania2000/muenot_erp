import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listJobs, createJob } from "@/lib/recruit-db"
import { canCreateInModule, scopeWhereForModule } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"

const PERMISSION_KEY = "recruitment.requisitions"
const AUDIT_MODULE = "recruit-jobs"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const scoped = await scopeWhereForModule(session, PERMISSION_KEY, "view", "recruit_jobs", "j")
  const jobs = await listJobs(scoped)
  return NextResponse.json({ jobs })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to add jobs" }, { status: 403 })
  }
  const body = await request.json()
  if (!body.title?.trim()) return NextResponse.json({ error: "Job title is required" }, { status: 400 })
  const result = await createJob(body, session.userId)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_jobs",
    recordId: (result as any)?.job_id ?? (result as any)?.id ?? null,
    action: "create",
    userId: session.userId,
    userName: session.name,
    newValue: { ...body, job_id: (result as any)?.job_id },
  })
  return NextResponse.json(result, { status: 201 })
}
