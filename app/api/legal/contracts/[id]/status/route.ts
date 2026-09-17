import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { setContractStatus } from "@/lib/legal-contracts-lifecycle"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const result = await setContractStatus(Number(id), body.status, {
    note: body.note ?? null,
    actorId: session.userId,
    actorName: session.name ?? null,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
  return NextResponse.json({ contract: result.contract })
}
