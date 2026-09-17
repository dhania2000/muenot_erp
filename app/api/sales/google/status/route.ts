import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getGoogleAccount } from "@/lib/google-accounts"
import { isGoogleOAuthConfigured, scopeGrantsGmailSend } from "@/lib/google-calendar"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getGoogleAccount(session.userId)

  return NextResponse.json({
    oauthConfigured: isGoogleOAuthConfigured(),
    connected: Boolean(account),
    email: account?.google_email ?? null,
    // Whether the connected account granted permission to send email. A user can
    // connect for Meet/Calendar only, so mailbox send is reported separately.
    mailboxConnected: Boolean(account && scopeGrantsGmailSend(account.scope)),
  })
}
