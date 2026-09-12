import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getWhatsAppAnalytics } from "@/lib/whatsapp-analytics"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"

/** Aggregated WhatsApp analytics for the Analytics tab (admins/analytics cap). */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canViewAnalytics) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const analytics = await getWhatsAppAnalytics()
  return NextResponse.json({ analytics })
}
