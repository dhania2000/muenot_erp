import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { iceServers } from "@/lib/calls-core"

export const dynamic = "force-dynamic"

/**
 * GET /api/calls/ice-servers — WebRTC STUN/TURN configuration (Phase 36/37).
 * Public STUN plus any operator-configured TURN (TURN_URL / TURN_USERNAME /
 * TURN_CREDENTIAL). No insecure open relay is created; TURN is only advertised
 * when credentials are present. Auth-gated so config isn't public.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json({ iceServers: iceServers() })
}
