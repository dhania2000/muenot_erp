import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { createVoiceToken, isCallingConfigured } from "@/lib/twilio"

export const dynamic = "force-dynamic"

// Issues a short-lived Twilio Voice access token for the recruitment browser dialer.
export async function POST() {
  const session = await requireFeature("recruitment.make_calls")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  if (!isCallingConfigured()) {
    return NextResponse.json({ configured: false }, { status: 200 })
  }

  const identity = `recruiter-${session.userId}`
  try {
    const token = createVoiceToken(identity)
    return NextResponse.json({ configured: true, token, identity })
  } catch (err) {
    console.error("[recruit/calls/token] failed to mint token", err)
    return NextResponse.json({ error: "Unable to create voice token" }, { status: 500 })
  }
}
