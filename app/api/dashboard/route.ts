import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getPersonalDashboard } from "@/lib/personal-dashboard"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const data = await getPersonalDashboard(session.userId, session.name)
  return NextResponse.json(data)
}
