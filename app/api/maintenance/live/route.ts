import { NextResponse } from "next/server"
import { listLiveWindowsForGate } from "@/lib/maintenance/store"
import { GATE_HEADER, maintenanceGateToken, safeEqual } from "@/lib/maintenance/gate-token"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Spec28 (#125) — Internal feed of live maintenance windows for the request
 * gate in middleware. Contains every tenant's windows, so it is guarded by a
 * secret derived from SESSION_SECRET and answers 404 to anyone else.
 */
export async function GET(req: Request) {
  const expected = await maintenanceGateToken(process.env.SESSION_SECRET)
  const presented = req.headers.get(GATE_HEADER) ?? ""
  if (!expected || !safeEqual(presented, expected)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  try {
    const windows = await listLiveWindowsForGate()
    return NextResponse.json({ windows }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Unavailable" }, { status: 503 })
  }
}
