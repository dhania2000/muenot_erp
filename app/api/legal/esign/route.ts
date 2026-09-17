import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  listEsignRequests,
  esignStats,
  createEsignRequest,
  addSigner,
  findOpenRequestForSource,
  getEsignRequest,
} from "@/lib/legal-esign"
import type { EsignSource, SignerType, SigningType } from "@/lib/legal-esign-shared"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const session = await requireFeature("legal.view_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = request.nextUrl.searchParams
  const [{ rows, total }, stats] = await Promise.all([
    listEsignRequests({
      search: sp.get("search") || undefined,
      status: sp.get("status") || undefined,
      source: sp.get("source") || undefined,
      signerType: sp.get("signerType") || undefined,
      dueAfter: sp.get("dueAfter") || undefined,
      dueBefore: sp.get("dueBefore") || undefined,
      limit: Number(sp.get("limit")) || 50,
      offset: Number(sp.get("offset")) || 0,
    }),
    esignStats(),
  ])
  return NextResponse.json({ requests: rows, total, stats })
}

export async function POST(request: NextRequest) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await request.json().catch(() => ({}))

  if (!body.title || String(body.title).trim().length === 0) {
    return NextResponse.json({ error: "A document title is required" }, { status: 400 })
  }

  const documentSource: EsignSource = body.documentSource || body.source || "manual"
  const contractId = body.contractId ? Number(body.contractId) : null
  const sourceRecordId = body.sourceRecordId ? String(body.sourceRecordId) : null

  // Duplicate protection (Phase 82) — surface the existing open request unless
  // the caller explicitly forces a new one.
  if (!body.force) {
    const existing = await findOpenRequestForSource({ contractId, documentSource, sourceRecordId })
    if (existing) {
      return NextResponse.json(
        { error: "An open signature request already exists for this document", existingId: existing },
        { status: 409 },
      )
    }
  }

  const req = await createEsignRequest({
    title: String(body.title).trim(),
    documentSource,
    contractId,
    templateId: body.templateId ? Number(body.templateId) : null,
    templateVersion: body.templateVersion ? Number(body.templateVersion) : null,
    sourceModule: body.sourceModule ?? null,
    sourceRecordId,
    signingType: (body.signingType as SigningType) || "sequential",
    dueDate: body.dueDate || null,
    message: body.message ?? null,
    autoEmailSigned: !!body.autoEmailSigned,
    requireConfirm: body.requireConfirm !== false,
    createdBy: session.userId,
    createdByName: session.name ?? null,
  })

  const signers = Array.isArray(body.signers) ? body.signers : []
  for (const s of signers) {
    if (!s?.name || !s?.email) continue
    await addSigner(req.id, {
      signerType: (s.signerType as SignerType) || "external",
      refId: s.refId ?? null,
      signatoryId: s.signatoryId ? Number(s.signatoryId) : null,
      name: String(s.name),
      email: String(s.email),
      mobile: s.mobile ?? null,
      role: s.role ?? null,
      signingOrder: s.signingOrder ? Number(s.signingOrder) : null,
    })
  }

  const full = await getEsignRequest(req.id)
  return NextResponse.json({ request: full }, { status: 201 })
}
