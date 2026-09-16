import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { setRequisitionApproval, createJobFromRequisition } from "@/lib/recruit-integrations-db"

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const body = await request.json()
  const action = body.action as string

  try {
    if (action === "create-job") {
      const result = await createJobFromRequisition(id, session.userId)
      return NextResponse.json({ ok: true, ...result })
    }
    if (action === "submit" || action === "approve" || action === "reject" || action === "reset") {
      const result = await setRequisitionApproval(id, action, {
        userId: session.userId,
        userName: session.name,
        notes: body.notes ?? null,
      })
      return NextResponse.json({ ok: true, ...result })
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Action failed" }, { status: 400 })
  }
}
