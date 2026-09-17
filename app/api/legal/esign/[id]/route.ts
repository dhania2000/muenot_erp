import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"
import { getEsignRequest } from "@/lib/legal-esign"
import type { SigningType } from "@/lib/legal-esign-shared"

export const runtime = "nodejs"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const req = await getEsignRequest(Number(id))
  if (!req) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ request: req })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const req = await getEsignRequest(Number(id))
  if (!req) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (req.status !== "Draft") {
    return NextResponse.json({ error: "Only draft requests can be edited" }, { status: 409 })
  }
  const body = await request.json().catch(() => ({}))
  const sets: string[] = []
  const values: any[] = []
  const push = (col: string, val: any) => {
    sets.push(`${col} = ?`)
    values.push(val)
  }
  if (body.title !== undefined) push("title", String(body.title).trim())
  if (body.signingType !== undefined) push("signing_type", (body.signingType as SigningType) || "sequential")
  if (body.dueDate !== undefined) push("due_date", body.dueDate || null)
  if (body.message !== undefined) push("message", body.message ?? null)
  if (body.autoEmailSigned !== undefined) push("auto_email_signed", body.autoEmailSigned ? 1 : 0)
  if (body.requireConfirm !== undefined) push("require_confirm", body.requireConfirm ? 1 : 0)
  if (sets.length) {
    values.push(Number(id))
    await query(`UPDATE legal_esign_requests SET ${sets.join(", ")} WHERE id = ?`, values)
  }
  const updated = await getEsignRequest(Number(id))
  return NextResponse.json({ request: updated })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const req = await getEsignRequest(Number(id))
  if (!req) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (req.status !== "Draft") {
    return NextResponse.json({ error: "Only draft requests can be deleted" }, { status: 409 })
  }
  await query(`DELETE FROM legal_esign_fields WHERE request_id = ?`, [Number(id)])
  await query(`DELETE FROM legal_esign_signers WHERE request_id = ?`, [Number(id)])
  await query(`DELETE FROM legal_esign_events WHERE request_id = ?`, [Number(id)])
  await query(`DELETE FROM legal_esign_requests WHERE id = ?`, [Number(id)])
  return NextResponse.json({ ok: true })
}
