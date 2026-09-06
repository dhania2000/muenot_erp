import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getDashboardStats } from "@/lib/recruit-db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const stats = await getDashboardStats()
  return NextResponse.json(stats)
}
