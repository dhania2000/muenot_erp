import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getAffiliatePortal } from "@/lib/affiliates/store"
import { partnerErrorResponse } from "@/lib/partners/http"

export const runtime = "nodejs"

/**
 * Spec30 — Affiliate portal. The affiliate is resolved from the caller's
 * active partner membership; request input can never select another one.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  try {
    return NextResponse.json(await getAffiliatePortal(session.userId, new Date()), {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (err) {
    return partnerErrorResponse(err, "Failed to load affiliate portal")
  }
}
