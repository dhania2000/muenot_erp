import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getJobReport } from "@/lib/recruit-db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const rows = await getJobReport()
  return NextResponse.json({ report: rows })
}
