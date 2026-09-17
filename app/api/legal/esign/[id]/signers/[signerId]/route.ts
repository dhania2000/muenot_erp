import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { removeSigner, getEsignRequest } from "@/lib/legal-esign"

export const runtime = "nodejs"

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; signerId: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id, signerId } = await params
  const req = await getEsignRequest(Number(id))
  if (!req) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (req.status !== "Draft") {
    return NextResponse.json({ error: "Signers can only be changed while the request is a draft" }, { status: 409 })
  }
  await removeSigner(Number(id), Number(signerId))
  const updated = await getEsignRequest(Number(id))
  return NextResponse.json({ request: updated })
}
