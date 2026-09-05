import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getGoogleAccount } from "@/lib/google-accounts"
import { isGoogleOAuthConfigured } from "@/lib/google-calendar"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getGoogleAccount(session.userId)

  return NextResponse.json({
    oauthConfigured: isGoogleOAuthConfigured(),
    connected: Boolean(account),
    email: account?.google_email ?? null,
  })
}
