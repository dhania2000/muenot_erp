import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { SupportSlaError, getMyTicket } from "@/lib/support-sla/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** One of the caller's tenant tickets + customer-visible timeline. Other tenants' ids → 404. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const id = Number((await params).id)
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid ticket id" }, { status: 400 })
  try {
    return NextResponse.json(await getMyTicket(id))
  } catch (error) {
    if (error instanceof SupportSlaError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("[support-sla] detail failed", error)
    return NextResponse.json({ error: "Unable to load ticket" }, { status: 500 })
  }
}
