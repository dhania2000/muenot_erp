import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listJobs, createJob } from "@/lib/recruit-db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const jobs = await listJobs()
  return NextResponse.json({ jobs })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  if (!body.title?.trim()) return NextResponse.json({ error: "Job title is required" }, { status: 400 })
  const result = await createJob(body, session.userId)
  return NextResponse.json(result, { status: 201 })
}
