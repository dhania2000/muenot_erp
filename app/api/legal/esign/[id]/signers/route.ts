import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { addSigner, getEsignRequest } from "@/lib/legal-esign"
import { getSignatory } from "@/lib/legal-esign-signatories"
import type { SignerType } from "@/lib/legal-esign-shared"

export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const req = await getEsignRequest(Number(id))
  if (!req) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (req.status !== "Draft") {
    return NextResponse.json({ error: "Signers can only be changed while the request is a draft" }, { status: 409 })
  }
  const body = await request.json().catch(() => ({}))
  if (!body.name || !body.email) {
    return NextResponse.json({ error: "Signer name and email are required" }, { status: 400 })
  }

  // Authorized-signatory guard (Phases 16, 68): only active signatories usable.
  let signatoryId: number | null = body.signatoryId ? Number(body.signatoryId) : null
  if (signatoryId) {
    const sig = await getSignatory(signatoryId)
    if (!sig || sig.status !== "Active") {
      return NextResponse.json({ error: "That authorized signatory is not active" }, { status: 400 })
    }
  }

  // Prevent duplicate signer email within the same request (Phase 82).
  const dup = (req.signers || []).find((s) => s.email.toLowerCase() === String(body.email).toLowerCase())
  if (dup) return NextResponse.json({ error: "That signer is already on this request" }, { status: 409 })

  const signer = await addSigner(req.id, {
    signerType: (body.signerType as SignerType) || "external",
    refId: body.refId ?? null,
    signatoryId,
    name: String(body.name),
    email: String(body.email),
    mobile: body.mobile ?? null,
    role: body.role ?? null,
    signingOrder: body.signingOrder ? Number(body.signingOrder) : null,
  })
  const updated = await getEsignRequest(req.id)
  return NextResponse.json({ signer, request: updated }, { status: 201 })
}
