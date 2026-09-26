import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction, getTenantId } from "@/lib/api-auth"
import { parseResolvePayload } from "@/lib/finance-three-way-match"
import { resolveMatchException } from "@/lib/finance-three-way-match-server"

export const runtime = "nodejs"

// POST /api/finance/three-way-match/:billId/resolve
//   Body: { decision: "approve" | "reject", note: string }
//   Header (optional): Idempotency-Key — a retried decision replays the first
//     result instead of applying twice.
//
//   An authorised checker approves (releases the payment hold) or rejects
//   (keeps it held) a match exception. Segregation of duties is enforced
//   server-side (the bill's creator and the PO approver are refused), every
//   override is audited with the evidence + note, and the record's tenant is
//   the caller's own — a bill from another tenant returns 404.
export async function POST(req: NextRequest, { params }: { params: Promise<{ billId: string }> }) {
  const session = await requireModuleAction("finance.purchase_bills", "update")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { billId } = await params
  const body = await req.json().catch(() => ({}))
  const parsed = parseResolvePayload(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const idempotencyKey = req.headers.get("Idempotency-Key") || req.headers.get("idempotency-key")

  const outcome = await resolveMatchException(tenantId, billId, parsed.value.decision, {
    userId: session.userId,
    userName: session.name ?? null,
    note: parsed.value.note,
    idempotencyKey,
  })

  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
  return NextResponse.json({ match: outcome.match, replayed: outcome.replayed ?? false })
}
