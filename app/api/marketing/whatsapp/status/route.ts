import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getConnectionHealth } from "@/lib/whatsapp-health"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"

/** Connection health + the caller's effective WhatsApp capabilities. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const [health, caps] = await Promise.all([
    getConnectionHealth(),
    resolveWhatsAppCaps(session),
  ])
  return NextResponse.json({ health, caps, role: session.role })
}
