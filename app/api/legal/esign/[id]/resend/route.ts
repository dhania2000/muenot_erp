import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { resendToSigner } from "@/lib/legal-esign-workflow"

export const runtime = "nodejs"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  if (!body.signerId) return NextResponse.json({ error: "signerId is required" }, { status: 400 })
  const result = await resendToSigner({
    requestId: Number(id),
    signerId: Number(body.signerId),
    actorId: session.userId,
    actorName: session.name ?? null,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result)
}
