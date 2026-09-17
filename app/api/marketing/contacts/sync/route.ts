import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureContactSchema, syncFromClients, syncFromLeads } from "@/lib/marketing/contacts-db"

/**
 * Pull people from the canonical Clients and Leads masters into the marketing
 * audience without duplicating them. Existing contacts are matched by source
 * link, then email, then phone, and only linked / enriched — never re-created.
 */
export async function POST(request: Request) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const source = String(body.source ?? "all")

  const result: Record<string, { created: number; updated: number; skipped: number }> = {}
  if (source === "all" || source === "clients") {
    result.clients = await syncFromClients(session.userId)
  }
  if (source === "all" || source === "leads") {
    result.leads = await syncFromLeads(session.userId)
  }

  return NextResponse.json({ ok: true, result })
}
