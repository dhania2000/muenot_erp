import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getGoogleAccount } from "@/lib/google-accounts"
import { isGoogleOAuthConfigured, listCalendarEventsForUser } from "@/lib/google-calendar"

/**
 * Live calendar feed for the signed-in employee. Each employee connects their
 * own Google account (stored per user in `sales_google_accounts`), so this
 * returns events straight from *their* primary Google Calendar.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const now = Date.now()
  const timeMin = url.searchParams.get("timeMin") || new Date(now - 45 * 864e5).toISOString()
  const timeMax = url.searchParams.get("timeMax") || new Date(now + 45 * 864e5).toISOString()

  const oauthConfigured = isGoogleOAuthConfigured()
  const account = await getGoogleAccount(session.userId)

  if (!oauthConfigured || !account) {
    return NextResponse.json({
      oauthConfigured,
      connected: Boolean(account),
      email: account?.google_email ?? null,
      events: [],
    })
  }

  try {
    const events = await listCalendarEventsForUser(account.refresh_token, { timeMin, timeMax })
    return NextResponse.json({
      oauthConfigured: true,
      connected: true,
      email: account.google_email,
      events,
    })
  } catch (err: any) {
    console.error("[v0] Google Calendar sync failed:", err?.message || err)
    return NextResponse.json(
      {
        oauthConfigured: true,
        connected: true,
        email: account.google_email,
        events: [],
        error: "sync_failed",
      },
      { status: 200 },
    )
  }
}
