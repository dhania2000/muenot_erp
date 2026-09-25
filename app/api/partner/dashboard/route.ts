import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getPartnerDashboard } from "@/lib/partners/store"
import { partnerErrorResponse } from "@/lib/partners/http"

export const runtime = "nodejs"

/**
 * Partner-facing dashboard. The partner is derived from the caller's active
 * membership (never from request input) and the payload is an allow-listed
 * projection: customer names, attribution state and commission ledger only.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  try {
    return NextResponse.json(await getPartnerDashboard(session.userId), {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to load partner dashboard")
  }
}
