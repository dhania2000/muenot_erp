import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { getConversation, linkContactToLead, normalizePhone } from "@/lib/whatsapp-store"

type LeadCandidate = {
  id: number
  lead_code: string
  contact_person: string | null
  company_name: string | null
  contact_number: string | null
  status: string
}

/**
 * GET  — lead candidates to link (matched by the contact's phone number and/or
 *        a free-text search), so the agent never creates a duplicate CRM lead.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const conversation = await getConversation(Number(id))
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 })

  const url = new URL(request.url)
  const term = url.searchParams.get("q")?.trim() || ""
  const like = `%${term}%`
  const last10 = normalizePhone(conversation.phoneNumber).slice(-10)

  let candidates: LeadCandidate[]
  try {
    candidates = await query<LeadCandidate[]>(
      `SELECT id, lead_code, contact_person, company_name, contact_number, status
         FROM \`sales_leads\`
        WHERE (? = '' OR contact_person LIKE ? OR company_name LIKE ? OR lead_code LIKE ? OR contact_number LIKE ?)
           OR RIGHT(REGEXP_REPLACE(COALESCE(contact_number,''), '[^0-9]', ''), 10) = ?
        ORDER BY created_at DESC
        LIMIT 20`,
      [term, like, like, like, like, last10],
    )
  } catch {
    // Fallback for MySQL < 8 (no REGEXP_REPLACE): text search only.
    candidates = await query<LeadCandidate[]>(
      `SELECT id, lead_code, contact_person, company_name, contact_number, status
         FROM \`sales_leads\`
        WHERE ? = '' OR contact_person LIKE ? OR company_name LIKE ? OR lead_code LIKE ? OR contact_number LIKE ?
        ORDER BY created_at DESC
        LIMIT 20`,
      [term, like, like, like, like],
    )
  }

  return NextResponse.json({ candidates })
}

/**
 * POST — links a lead to this conversation's contact, unlinks it (leadId: null),
 *        or creates a brand-new lead from the conversation and links it. Never
 *        duplicates: linking an existing lead is preferred.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const conversation = await getConversation(Number(id))
  if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 })

  const body = (await request.json().catch(() => ({}))) as {
    leadId?: number | null
    create?: { contactPerson?: string; companyName?: string }
  }

  // Create + link path.
  if (body.create) {
    const contactPerson = body.create.contactPerson?.trim()
    const companyName = body.create.companyName?.trim()
    if (!contactPerson || !companyName) {
      return NextResponse.json(
        { error: "Contact person and company name are required to create a lead." },
        { status: 400 },
      )
    }

    const [{ next }] = await query<{ next: number }[]>(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(lead_code, 5) AS UNSIGNED)), 0) + 1 AS next FROM sales_leads",
    )
    const leadCode = `MLD-${String(next).padStart(3, "0")}`

    const result = await query<{ insertId: number }>(
      `INSERT INTO sales_leads
        (lead_code, lead_date, contact_person, contact_number, lead_source, company_name, status, created_by)
       VALUES (?, ?, ?, ?, 'WhatsApp', ?, 'New', ?)`,
      [leadCode, new Date(), contactPerson, conversation.phoneNumber, companyName, session.userId],
    )
    await linkContactToLead(conversation.contactId, result.insertId)
    return NextResponse.json({ ok: true, leadId: result.insertId, leadCode })
  }

  // Link / unlink an existing lead.
  const leadId = body.leadId === null ? null : Number(body.leadId)
  if (leadId !== null && (!Number.isInteger(leadId) || leadId <= 0)) {
    return NextResponse.json({ error: "A valid leadId is required." }, { status: 400 })
  }
  await linkContactToLead(conversation.contactId, leadId)
  return NextResponse.json({ ok: true, leadId })
}
