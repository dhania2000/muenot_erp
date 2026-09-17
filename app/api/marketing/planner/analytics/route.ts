import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { analytics } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const scope = url.searchParams.get("scope")
  // Restrict analytics to the caller's own workload when requested.
  const scopeUserId = scope === "mine" ? session.userId : undefined

  const data = await analytics(scopeUserId)
  return NextResponse.json({ analytics: data })
}
