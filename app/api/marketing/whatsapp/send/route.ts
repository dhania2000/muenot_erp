import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getWhatsAppIntegration, sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/whatsapp"

/**
 * Sends a message from the connected WhatsApp Business number.
 *
 * Free-form text only reaches a recipient inside the 24-hour customer service
 * window; for a cold send (e.g. a broadcast or a first "test") Meta requires an
 * approved template, so callers can pass `mode: "template"` with a template
 * name (defaulting to the built-in `hello_world`).
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const integration = await getWhatsAppIntegration()
  if (!integration) {
    return NextResponse.json({ error: "No WhatsApp account is connected yet." }, { status: 400 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    to?: string
    message?: string
    mode?: "text" | "template"
    templateName?: string
    languageCode?: string
  }

  const to = body.to?.trim().replace(/[^\d]/g, "")
  if (!to) {
    return NextResponse.json(
      { error: "A recipient phone number (with country code) is required." },
      { status: 400 },
    )
  }

  const mode = body.mode === "template" ? "template" : "text"

  const result =
    mode === "template"
      ? await sendWhatsAppTemplate({
          integration,
          to,
          templateName: body.templateName?.trim() || "hello_world",
          languageCode: body.languageCode?.trim() || "en_US",
        })
      : await sendWhatsAppText({
          integration,
          to,
          body: body.message?.trim() || "",
        })

  if (mode === "text" && !body.message?.trim()) {
    return NextResponse.json({ error: "Message body is required." }, { status: 400 })
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Failed to send message." }, { status: 502 })
  }

  return NextResponse.json({ ok: true, messageId: result.messageId })
}
