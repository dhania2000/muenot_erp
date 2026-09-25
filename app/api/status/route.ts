import { NextResponse } from "next/server"
import { getPublicStatus } from "@/lib/status/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Spec28 (#126) — Public component status. Unauthenticated by design and
 * exempt from maintenance gating; returns only measured component states,
 * public incident updates and announced platform maintenance (no internals).
 */
export async function GET() {
  try {
    const status = await getPublicStatus()
    return NextResponse.json(status, { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=30" } })
  } catch (error) {
    console.error("[status] public status failed", error)
    return NextResponse.json(
      { error: "Status is temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    )
  }
}
