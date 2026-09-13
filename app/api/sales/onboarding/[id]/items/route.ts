import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { addSubItem, onboardingErrorStatus, SUB_ITEM_KINDS, type SubItemKind } from "@/lib/sales/onboarding-service"

/**
 * POST /api/sales/onboarding/[id]/items — add an owned sub-item.
 * Body: { kind: "checklist"|"task"|"milestone"|"document"|"risk"|"team", ...fields }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const kind = String(body.kind || "") as SubItemKind
  if (!SUB_ITEM_KINDS.includes(kind)) {
    return NextResponse.json({ error: `Unknown sub-item kind: ${body.kind}` }, { status: 400 })
  }
  try {
    const result = await addSubItem(Number(id), kind, body, session.userId)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Failed to add item" },
      { status: onboardingErrorStatus(err) },
    )
  }
}
