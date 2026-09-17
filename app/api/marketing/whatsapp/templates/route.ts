import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  getWhatsAppIntegration,
  createWhatsAppTemplate,
  type TemplateCategory,
} from "@/lib/whatsapp"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"
import {
  listLocalTemplates,
  syncTemplatesFromMeta,
  templateExists,
} from "@/lib/whatsapp-templates"

/**
 * Lists templates from the LOCAL catalog. By default it first reconciles the
 * catalog with Meta (so status changes, rejection reasons and new templates show
 * up), then returns the persisted rows with usage counts and versions. Pass
 * `?sync=0` to skip the Meta round-trip and read the cache only.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const integration = await getWhatsAppIntegration()
  if (!integration) {
    return NextResponse.json({ error: "No WhatsApp account is connected yet." }, { status: 400 })
  }

  const url = new URL(request.url)
  const skipSync = url.searchParams.get("sync") === "0"

  let syncError: string | undefined
  if (!skipSync) {
    const result = await syncTemplatesFromMeta(integration)
    if (!result.ok) syncError = result.error
  }

  const templates = await listLocalTemplates()
  return NextResponse.json({ templates, syncError })
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

  // Duplicate guard: Meta rejects a re-submitted name+language, so fail fast with
  // a friendly message instead of surfacing an opaque Graph error.
  const cleanName = name.trim().toLowerCase().replace(/\s+/g, "_")
  if (cleanName && (await templateExists(cleanName, language))) {
    return NextResponse.json(
      { error: `A template named "${cleanName}" (${language}) already exists.` },
      { status: 409 },
    )
  }

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

  // Persist immediately so the new PENDING template shows up without waiting for
  // the next full sync. Best-effort — the create already succeeded on Meta.
  await syncTemplatesFromMeta(integration).catch(() => {})

  return NextResponse.json({ id: result.id, status: result.status, category: result.category })
}
