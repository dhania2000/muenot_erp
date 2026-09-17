import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { signInternally } from "@/lib/legal-esign-workflow"
import { clientIp } from "@/lib/legal-esign-shared-server"

export const runtime = "nodejs"

/**
 * Apply a Muenot authorized signatory's saved signature directly from the ERP
 * (Phase 35). Requires manage permission — enforcing Phase 67 (only users
 * authorized to send documents may use a signatory's saved signature).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.signerId) return NextResponse.json({ error: "signerId is required" }, { status: 400 })
  const result = await signInternally({
    requestId: Number(id),
    signerId: Number(body.signerId),
    actorId: session.userId,
    actorName: session.name ?? null,
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result)
}
