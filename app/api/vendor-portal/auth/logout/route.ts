import { NextResponse } from "next/server"
import { clearVendorPortalSessionCookie } from "@/lib/vendor-portal/auth"

export async function POST() {
  await clearVendorPortalSessionCookie()
  return NextResponse.json({ ok: true })
}
