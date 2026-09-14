import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  getWhatsAppIntegration,
  getWhatsAppTemplates,
  createWhatsAppTemplate,
  type TemplateCategory,
} from "@/lib/whatsapp"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"

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

const CATEGORIES: TemplateCategory[] = ["UTILITY", "MARKETING", "AUTHENTICATION"]

/**
 * Creates a new template from the ERP and submits it to Meta for review, so an
 * employee never has to log into the Meta Business Manager. Gated on the same
 * capability that lets an agent send templates.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canSendTemplates) {
    return NextResponse.json({ error: "You do not have permission to create templates." }, { status: 403 })
  }

  const integration = await getWhatsAppIntegration()
  if (!integration) {
    return NextResponse.json({ error: "No WhatsApp account is connected yet." }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as {
    name?: unknown
    language?: unknown
    category?: unknown
    headerText?: unknown
    bodyText?: unknown
    footerText?: unknown
    bodyExamples?: unknown
  } | null
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 })

  const name = typeof body.name === "string" ? body.name : ""
  const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : "en_US"
  const category = CATEGORIES.includes(body.category as TemplateCategory)
    ? (body.category as TemplateCategory)
    : "UTILITY"
  const bodyText = typeof body.bodyText === "string" ? body.bodyText : ""
  const headerText = typeof body.headerText === "string" ? body.headerText : undefined
  const footerText = typeof body.footerText === "string" ? body.footerText : undefined
  const bodyExamples = Array.isArray(body.bodyExamples)
    ? body.bodyExamples.filter((v): v is string => typeof v === "string")
    : []

  const result = await createWhatsAppTemplate(integration, {
    name,
    language,
    category,
    headerText,
    bodyText,
    footerText,
    bodyExamples,
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Failed to create template." }, { status: 502 })
  }

  return NextResponse.json({ id: result.id, status: result.status, category: result.category })
}
