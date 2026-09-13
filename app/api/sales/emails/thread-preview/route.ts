import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { baseSubject, ensureEmailTables, getLatestSuccessfulEmailByEmail } from "@/lib/email"

/**
 * Composer helper: resolve what a Follow Up would thread into for a given
 * recipient, WITHOUT sending anything. The compose dialog calls this whenever
 * Mail Type = Follow Up and the recipient address changes, so it can show the
 * user the exact conversation the reply will join (or tell them none exists and
 * disable Send).
 *
 * Threading identity is the email ADDRESS (normalized), never the lead — the
 * same person may have been emailed under a different or absent lead. This uses
 * the same authoritative resolver the POST handler uses, so the preview can
 * never disagree with what actually happens on send.
 */
export async function GET(request: Request) {
  const session = await requireFeature("sales.send_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()

  const email = (new URL(request.url).searchParams.get("email") || "").trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ found: false, error: "Enter a valid recipient email address." })
  }

  const anchor = await getLatestSuccessfulEmailByEmail(email)
  if (!anchor) {
    return NextResponse.json({ found: false, email: email.toLowerCase() })
  }

  return NextResponse.json({
    found: true,
    email: email.toLowerCase(),
    thread: {
      latestEmailId: anchor.latestEmailId,
      threadId: anchor.threadId,
      // The subject the reply will actually carry ("Re: <root>"), so the UI can
      // show the user the controlled subject before they send.
      rootSubject: baseSubject(anchor.rootSubject),
      replySubject: `Re: ${baseSubject(anchor.rootSubject)}`,
      sentAt: anchor.sentAt,
      toEmail: anchor.toEmail,
      toName: anchor.toName,
      openCount: anchor.openCount,
      // True when the anchor carries a provider (Gmail) conversation id, i.e. the
      // reply can be guaranteed into the same Gmail thread.
      providerThreaded: Boolean(anchor.providerThreadId),
    },
  })
}
