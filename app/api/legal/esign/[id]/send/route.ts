import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { sendEsignRequest } from "@/lib/legal-esign-workflow"

export const runtime = "nodejs"

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const result = await sendEsignRequest({
    requestId: Number(id),
    actorId: session.userId,
    actorName: session.name ?? null,
  })
  if (!result.ok && result.sent === 0) {
    return NextResponse.json({ error: result.error || "Could not send", failures: result.failures }, { status: 400 })
  }
  return NextResponse.json(result)
}
