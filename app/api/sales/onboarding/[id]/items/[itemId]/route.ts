import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { deleteSubItem, onboardingErrorStatus, SUB_ITEM_KINDS, updateSubItem, type SubItemKind } from "@/lib/sales/onboarding-service"

/** PATCH /api/sales/onboarding/[id]/items/[itemId] — update an owned sub-item. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const session = await requireFeature("sales.manage_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id, itemId } = await params
  const body = await request.json().catch(() => ({}))
  const kind = String(body.kind || "") as SubItemKind
  if (kind === "team" || !SUB_ITEM_KINDS.includes(kind)) {
    return NextResponse.json({ error: `Cannot update sub-item kind: ${body.kind}` }, { status: 400 })
  }
  try {
    const result = await updateSubItem(Number(id), kind as Exclude<SubItemKind, "team">, Number(itemId), body, session.userId)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Failed to update item" },
      { status: onboardingErrorStatus(err) },
    )
  }
}

/** DELETE /api/sales/onboarding/[id]/items/[itemId]?kind=task — remove an owned sub-item. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const session = await requireFeature("sales.manage_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id, itemId } = await params
  const kind = String(new URL(request.url).searchParams.get("kind") || "") as SubItemKind
  if (!SUB_ITEM_KINDS.includes(kind)) {
    return NextResponse.json({ error: `Unknown sub-item kind: ${kind}` }, { status: 400 })
  }
  try {
    const result = await deleteSubItem(Number(id), kind, Number(itemId), session.userId)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Failed to delete item" },
      { status: onboardingErrorStatus(err) },
    )
  }
}
