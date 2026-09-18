import { type NextRequest, NextResponse } from "next/server"
import { acceptInvitation, getInvitationByToken, LifecycleError } from "@/lib/user-lifecycle"

/**
 * SPEC 14 — Public invitation endpoints (no session required; the token is the
 * capability). GET validates a token so the acceptance page can render the
 * invitee's email; POST accepts it, setting the password and activating.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const invite = await getInvitationByToken(token)
  if (!invite) return NextResponse.json({ error: "This invitation is not valid" }, { status: 404 })
  if (invite.expired) return NextResponse.json({ error: "This invitation has expired", expired: true }, { status: 410 })
  return NextResponse.json({ email: invite.email, name: invite.name })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    await acceptInvitation(token, { name: body?.name, password: String(body?.password ?? "") })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof LifecycleError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[auth/invitations] accept failed:", err)
    return NextResponse.json({ error: "Failed to accept the invitation" }, { status: 500 })
  }
}
