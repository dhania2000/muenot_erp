import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureContactSchema, mergeContacts, ContactNotFoundError } from "@/lib/marketing/contacts-db"

export async function POST(request: Request) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const survivorId = Number(body.survivorId)
  const duplicateId = Number(body.duplicateId)
  if (!survivorId || !duplicateId) {
    return NextResponse.json({ error: "Both survivor and duplicate are required" }, { status: 400 })
  }
  if (survivorId === duplicateId) {
    return NextResponse.json({ error: "Cannot merge a contact into itself" }, { status: 400 })
  }

  try {
    await mergeContacts({ survivorId, duplicateId, actorId: session.userId })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof ContactNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    console.error("[contacts-merge] failed", error)
    return NextResponse.json({ error: "Unable to merge contacts" }, { status: 500 })
  }
}
