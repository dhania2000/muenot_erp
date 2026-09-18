import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { actOnApprovalRequest, type ActInput } from "@/lib/approval-authority"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!getCurrentTenant()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = (await request.json().catch(() => null)) as {
    action?: ActInput["action"]
    comment?: string | null
    delegateToUserId?: number | null
  } | null

  const action = body?.action
  if (!action || !["approve", "reject", "delegate", "escalate", "cancel"].includes(action))
    return NextResponse.json({ error: "A valid action is required" }, { status: 400 })

  const result = await actOnApprovalRequest(
    {
      requestId: Number(id),
      actorId: session.userId,
      actorName: session.name ?? null,
      action,
      comment: body?.comment ?? null,
      delegateToUserId: body?.delegateToUserId ?? null,
    },
    { isAdmin: session.role === "admin" },
  )

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
  return NextResponse.json({ ok: true, status: result.status, currentLevel: result.currentLevel })
}
