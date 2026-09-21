import { NextResponse } from "next/server"
import { trackTenantEmail } from "@/lib/email-engine/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Transparent 1×1 GIF. Tracking is recorded only for sends with explicit consent.
const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (/^[a-f0-9]{48}$/i.test(token)) await trackTenantEmail(token, "open").catch(() => {})
  return new NextResponse(pixel, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, private" } })
}
