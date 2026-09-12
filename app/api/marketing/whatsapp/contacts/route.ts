import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { findOrCreateContact, listContacts, normalizePhone } from "@/lib/whatsapp-store"
import { resolveWhatsAppCaps } from "@/lib/whatsapp-platform"

/** WhatsApp contact directory with an optional name/phone search. */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const search = url.searchParams.get("search") ?? ""
  const limit = Number(url.searchParams.get("limit")) || 200

  const contacts = await listContacts(search, limit)
  return NextResponse.json({ contacts })
}

/** Creates (or returns an existing) contact by phone number. */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const caps = await resolveWhatsAppCaps(session)
  if (!caps.canManageContacts) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as { phone?: string; name?: string | null }
  const phone = normalizePhone(body.phone ?? "")
  if (phone.length < 8) return NextResponse.json({ error: "A valid phone number is required" }, { status: 400 })

  const contact = await findOrCreateContact({ phone, profileName: body.name ?? null })
  const contacts = await listContacts("", 200)
  return NextResponse.json({ ok: true, contact, contacts }, { status: 201 })
}
