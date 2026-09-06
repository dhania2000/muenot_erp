import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listInterviews, createInterview } from "@/lib/recruit-db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const interviews = await listInterviews()
  return NextResponse.json({ interviews })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  if (!body.candidate_name?.trim()) return NextResponse.json({ error: "Candidate is required" }, { status: 400 })
  const result = await createInterview(body, session.userId)
  return NextResponse.json(result, { status: 201 })
}
