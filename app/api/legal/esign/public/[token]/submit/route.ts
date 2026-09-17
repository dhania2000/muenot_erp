import { type NextRequest, NextResponse } from "next/server"
import { resolveSignerByToken } from "@/lib/legal-esign"
import { submitSignature } from "@/lib/legal-esign-workflow"
import { clientIp } from "@/lib/legal-esign-shared-server"
import type { SignatureMethod } from "@/lib/legal-esign-shared"

export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveSignerByToken(token)
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, reason: resolved.reason, error: friendly(resolved.reason) }, { status: 200 })
  }
  const body = await request.json().catch(() => ({}))
  const method = (body.method as SignatureMethod) || "draw"
  const result = await submitSignature({
    signerId: resolved.signer.id,
    method,
    imageData: body.imageData ?? null,
    confirmed: Boolean(body.confirmed),
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
    actorName: resolved.signer.name,
  })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
  return NextResponse.json(result)
}

function friendly(reason: string): string {
  switch (reason) {
    case "expired":
      return "This signing link has expired. Please ask the sender for a new link."
    case "used":
      return "This document has already been signed."
    case "closed":
      return "This request is no longer open for signing."
    default:
      return "This signing link is invalid."
  }
}
