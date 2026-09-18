import { type NextRequest, NextResponse } from "next/server"
import { verifyEmail, LifecycleError } from "@/lib/user-lifecycle"

/**
 * SPEC 14 — Consume an email-verification token (public; the token is the
 * capability). Idempotent: a second click on an already-verified account still
 * reports success as long as the token has not been consumed/expired.
 */
export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const token = String(body?.token ?? "")
  if (!token) return NextResponse.json({ error: "A verification token is required" }, { status: 400 })

  try {
    await verifyEmail(token)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof LifecycleError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[auth/verify-email] failed:", err)
    return NextResponse.json({ error: "Failed to verify email" }, { status: 500 })
  }
}
