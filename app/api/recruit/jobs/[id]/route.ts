import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getJobById, getJobQuestions, updateJob, deleteJob } from "@/lib/recruit-db"
import { canActOnRecord } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"

const PERMISSION_KEY = "recruitment.requisitions"
const AUDIT_MODULE = "recruit-jobs"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const job = await getJobById(id)
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const questions = await getJobQuestions(id)
  return NextResponse.json({ job, questions })
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const existing = await getJobById(id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!(await canActOnRecord(session, PERMISSION_KEY, "update", existing))) {
    return NextResponse.json({ error: "You do not have permission to edit this job" }, { status: 403 })
  }

  const body = await request.json()
  if (!body.title?.trim()) return NextResponse.json({ error: "Job title is required" }, { status: 400 })
  await updateJob(id, body)
  const after = await getJobById(id)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_jobs",
    recordId: id,
    action: "update",
    userId: session.userId,
    userName: session.name,
    oldValue: existing,
    newValue: after ?? body,
  })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const existing = await getJobById(id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!(await canActOnRecord(session, PERMISSION_KEY, "delete", existing))) {
    return NextResponse.json({ error: "You do not have permission to delete this job" }, { status: 403 })
  }

  await deleteJob(id)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_jobs",
    recordId: id,
    action: "delete",
    userId: session.userId,
    userName: session.name,
    oldValue: existing,
  })
  return NextResponse.json({ ok: true })
}
