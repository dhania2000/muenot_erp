import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { createVoiceToken, getCallerId, isCallingConfigured } from "@/lib/telnyx"

export const dynamic = "force-dynamic"

// Issues a short-lived Telnyx WebRTC token for the browser dialer.
export async function POST() {
  const session = await requireFeature("sales.make_calls")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  if (!isCallingConfigured()) {
    return NextResponse.json({ configured: false }, { status: 200 })
  }

  const identity = `agent-${session.userId}`
  try {
    const token = await createVoiceToken(identity)
    return NextResponse.json({ configured: true, token, identity, callerId: getCallerId() })
  } catch (err) {
    console.error("[calls/token] failed to mint token", err)
    return NextResponse.json({ error: "Unable to create voice token" }, { status: 500 })
  }
}
