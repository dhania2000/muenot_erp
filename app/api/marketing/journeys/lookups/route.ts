import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"
import { getWhatsAppIntegration, getWhatsAppTemplates } from "@/lib/whatsapp"

export const runtime = "nodejs"

/**
 * Bundled reference data for the journey builder: team members (owners /
 * notification recipients), email templates, marketing segments, and the
 * approved WhatsApp templates from the connected Cloud API account.
 */
export async function GET(_request: Request) {
  const session = await requireFeature("marketing.journeys.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const [users, templates, segments] = await Promise.all([
    query<any[]>(`SELECT id, name, email FROM users WHERE status = 'active' ORDER BY name ASC LIMIT 500`).catch(() => []),
    query<any[]>(
      `SELECT id, name, subject FROM sales_email_templates WHERE status = 'Active' ORDER BY name ASC LIMIT 500`,
    ).catch(() => []),
    query<any[]>(`SELECT id, name FROM marketing_segments ORDER BY name ASC LIMIT 500`).catch(() => []),
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
    // WhatsApp lookups are best-effort; the builder still works without them.
  }

  return NextResponse.json({ users, templates, segments, whatsappTemplates, whatsappConnected })
}
