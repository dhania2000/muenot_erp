import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureLeadGenSchema, getDashboard } from "@/lib/marketing/leadgen-db"

export async function GET(request: Request) {
  await ensureLeadGenSchema()
  const session = await requireFeature("marketing.lead_generation.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const days = Number(new URL(request.url).searchParams.get("days") || 30)
  const data = await getDashboard(days)
  return NextResponse.json(data)
}
