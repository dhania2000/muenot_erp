import { type NextRequest, NextResponse } from "next/server"
import { resolveSignerByToken } from "@/lib/legal-esign"
import { rejectSignature } from "@/lib/legal-esign-workflow"
import { clientIp } from "@/lib/legal-esign-shared-server"

export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveSignerByToken(token)
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, reason: resolved.reason }, { status: 200 })
  }
  const body = await request.json().catch(() => ({}))
  const result = await rejectSignature({
    signerId: resolved.signer.id,
    reason: String(body.reason || ""),
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
    actorName: resolved.signer.name,
  })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
  return NextResponse.json(result)
}
