import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import { createSubscription, listSubscriptions, SubscriptionError, type ListFilters } from "@/lib/company-subscriptions"

export const runtime = "nodejs"

function filtersFrom(req: NextRequest): ListFilters {
  const sp = req.nextUrl.searchParams
  return {
    search: sp.get("search"),
    status: sp.get("status"),
    category: sp.get("category"),
    vendor: sp.get("vendor"),
    department: sp.get("department"),
    billing_cycle: sp.get("billing_cycle"),
    expiring: sp.get("expiring") === "1",
    sort: sp.get("sort"),
    dir: (sp.get("dir") as "asc" | "desc" | null) ?? null,
  }
}

export async function GET(req: NextRequest) {
  const session = await requireFeature("assets.view_company_subscriptions")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const data = await listSubscriptions(filtersFrom(req))
  return NextResponse.json(data)
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction("assets.company_subscriptions", "add")
  if (!session) return NextResponse.json({ error: "You do not have permission to add subscriptions." }, { status: 403 })
  try {
    const body = await req.json().catch(() => ({}))
    const detail = await createSubscription(body, session)
    return NextResponse.json(detail, { status: 201 })
  } catch (error) {
    if (error instanceof SubscriptionError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] create subscription failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to create subscription." }, { status: 500 })
  }
}
