import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { contractEmailDraft, emailContract } from "@/lib/legal-contracts-email"
import { resolveBaseUrl } from "@/lib/email"

export const runtime = "nodejs"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const draft = await contractEmailDraft(Number(id))
  if (!draft.ok) return NextResponse.json({ error: draft.error }, { status: draft.code })
  return NextResponse.json(draft)
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const result = await emailContract(
    Number(id),
    {
      to: body.to ?? null,
      cc: body.cc ?? null,
      subject: body.subject ?? null,
      message: body.message ?? null,
      baseUrl: resolveBaseUrl(request),
    },
    { actorId: session.userId, actorName: session.name ?? null },
  )
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
  return NextResponse.json({ ok: true, to: result.to })
}
