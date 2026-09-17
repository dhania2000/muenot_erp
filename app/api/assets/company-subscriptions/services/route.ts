import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import { listServices, createService, SubscriptionError } from "@/lib/company-subscriptions"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const session = await requireFeature("assets.view_company_subscriptions")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const services = await listServices(req.nextUrl.searchParams.get("search"))
  return NextResponse.json({ services })
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction("assets.company_subscriptions", "add")
  if (!session) return NextResponse.json({ error: "You do not have permission to add services." }, { status: 403 })
  try {
    const body = await req.json().catch(() => ({}))
    const service = await createService(body, session)
    return NextResponse.json({ service }, { status: 201 })
  } catch (error) {
    if (error instanceof SubscriptionError) return NextResponse.json({ error: error.message }, { status: error.status })
    return NextResponse.json({ error: "Failed to add service." }, { status: 500 })
  }
}
