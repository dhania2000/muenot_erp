import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getAnalytics } from "@/lib/company-subscriptions"

export const runtime = "nodejs"

export async function GET() {
  const session = await requireFeature("assets.view_company_subscriptions")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const data = await getAnalytics()
  return NextResponse.json(data)
}
