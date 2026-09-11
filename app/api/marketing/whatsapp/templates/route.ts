import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getWhatsAppIntegration, getWhatsAppTemplates } from "@/lib/whatsapp"

/** Lists the message templates configured on the connected WABA. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const integration = await getWhatsAppIntegration()
  if (!integration) {
    return NextResponse.json({ error: "No WhatsApp account is connected yet." }, { status: 400 })
  }

  const result = await getWhatsAppTemplates(integration)
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Failed to load templates." }, { status: 502 })
  }

  return NextResponse.json({ templates: result.templates })
}
