import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getRecruitmentInsights } from "@/lib/recruit-report-insights"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const insights = await getRecruitmentInsights()
  return NextResponse.json(insights)
}
