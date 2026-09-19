import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"
import { getWhatsAppIntegration, getWhatsAppTemplates } from "@/lib/whatsapp"
import { CHANNELS, CONTENT_TYPES } from "@/lib/marketing/planner-constants"

export const runtime = "nodejs"

/**
 * Bundled reference data for the Planner item form and filters. Everything is
 * pulled from the EXISTING marketing / HR modules — no duplicate masters:
 *  - employees  -> users (HR Employee Master)
 *  - campaigns  -> marketing_whatsapp_campaigns
 *  - journeys   -> marketing_journeys
 *  - segments   -> marketing_segments
 *  - email tpls -> sales_email_templates
 *  - wa tpls    -> connected WhatsApp Cloud API account
 *
 * Channel availability (Phase 4 / 42) is narrowed to what is actually
 * configured: integration channels (Email / WhatsApp) only appear when their
 * systems are available.
 */
export async function GET(_request: Request) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const [employees, campaigns, journeys, segments, emailTemplates] = await Promise.all([
    query<any[]>(`SELECT id, name, email FROM users WHERE status = 'active' ORDER BY name ASC LIMIT 500`).catch(() => []),
    query<any[]>(`SELECT id, name, status FROM marketing_whatsapp_campaigns WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 500`, [currentTenantId()]).catch(
      () => [],
    ),
    query<any[]>(`SELECT id, name FROM marketing_journeys ORDER BY name ASC LIMIT 500`).catch(() => []),
    query<any[]>(`SELECT id, name FROM marketing_segments ORDER BY name ASC LIMIT 500`).catch(() => []),
    query<any[]>(
      `SELECT id, name, subject FROM sales_email_templates WHERE status = 'Active' ORDER BY name ASC LIMIT 500`,
    ).catch(() => []),
  ])

  let whatsappTemplates: { name: string; language: string; status: string }[] = []
  let whatsappConnected = false
  try {
    const integration = await getWhatsAppIntegration()
    if (integration) {
      whatsappConnected = true
      const res = await getWhatsAppTemplates(integration)
      if (res.ok) {
        whatsappTemplates = res.templates
          .filter((t) => t.status === "APPROVED")
          .map((t) => ({ name: t.name, language: t.language, status: t.status }))
      }
    }
  } catch {
    // Best-effort; the form still works without WhatsApp templates.
  }

  const emailConfigured = true // Email is a core system in this ERP (sales-emails engine).

  // Only surface integration channels that are actually available.
  const channels = CHANNELS.filter((c) => {
    if (c === "WhatsApp") return whatsappConnected
    if (c === "Email") return emailConfigured
    return true
  })

  return NextResponse.json({
    employees,
    campaigns,
    journeys,
    segments,
    emailTemplates,
    whatsappTemplates,
    whatsappConnected,
    emailConfigured,
    channels,
    contentTypes: CONTENT_TYPES,
  })
}
