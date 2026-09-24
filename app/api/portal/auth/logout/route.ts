import { NextResponse } from "next/server"
import { clearPortalSessionCookie } from "@/lib/portal/auth"

export async function POST() {
  await clearPortalSessionCookie()
  return NextResponse.json({ ok: true })
}
