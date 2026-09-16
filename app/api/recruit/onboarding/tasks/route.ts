import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listPrejoiningTasks, createPrejoiningTask } from "@/lib/recruit-integrations-db"

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const applicationId = request.nextUrl.searchParams.get("application_id") || undefined
  const tasks = await listPrejoiningTasks(applicationId)
  return NextResponse.json({ tasks })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  const result = await createPrejoiningTask(body, session.userId)
  return NextResponse.json(result, { status: 201 })
}
