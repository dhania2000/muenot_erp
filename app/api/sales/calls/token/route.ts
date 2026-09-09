import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { createVoiceToken, isCallingConfigured } from "@/lib/twilio"

export const dynamic = "force-dynamic"

// Issues a short-lived Twilio Voice access token for the browser dialer.
export async function POST() {
  const session = await requireFeature("sales.make_calls")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  if (!isCallingConfigured()) {
    return NextResponse.json({ configured: false }, { status: 200 })
  }

  const identity = `agent-${session.userId}`
  try {
    const token = createVoiceToken(identity)
    return NextResponse.json({ configured: true, token, identity })
  } catch (err) {
    console.error("[calls/token] failed to mint token", err)
    return NextResponse.json({ error: "Unable to create voice token" }, { status: 500 })
  }
}
