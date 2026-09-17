import { type NextRequest, NextResponse } from "next/server"
import { resolveSignerByToken, getRequestSigners } from "@/lib/legal-esign"
import { markSignerViewed } from "@/lib/legal-esign-workflow"
import { clientIp } from "@/lib/legal-esign-shared-server"

export const runtime = "nodejs"

/**
 * PUBLIC signer endpoint — no session. The single-use token IS the credential
 * (Phases 60-64). Returns only the data the signing page needs; the signed PDF
 * itself is never exposed here.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveSignerByToken(token)
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, reason: resolved.reason }, { status: 200 })
  }
  const { signer, request: req } = resolved

  // Mark viewed on first open (audit trail).
  await markSignerViewed({
    signerId: signer.id,
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  }).catch(() => {})

  const allSigners = await getRequestSigners(req.id)
  return NextResponse.json({
    ok: true,
    signer: {
      id: signer.id,
      name: signer.name,
      email: signer.email,
      role: signer.role,
      signer_type: signer.signer_type,
      signatory_id: signer.signatory_id,
      fields: signer.fields || [],
    },
    request: {
      id: req.id,
      request_uid: req.request_uid,
      title: req.title,
      message: req.message,
      due_date: req.due_date,
      status: req.status,
      require_confirm: req.require_confirm,
      contract_reference: req.contract_reference,
    },
    // Progress context for the signer, no PII beyond names/status.
    progress: allSigners.map((s) => ({ name: s.name, role: s.role, status: s.status })),
  })
}
