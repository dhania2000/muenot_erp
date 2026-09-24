import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { submitForApproval, decideApproval, propagateUnblock, TaskError } from "@/lib/tasks/model"

function parseId(raw: string): number {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  try {
    const body = await req.json()
    const action = body.action
    if (action === "submit") {
      await submitForApproval(id, Number(body.approver_id), body.approver_name ?? null)
    } else if (action === "approve" || action === "reject") {
      await decideApproval(id, action === "approve" ? "approved" : "rejected", body.note ?? null)
      if (action === "approve") await propagateUnblock(id)
    } else {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    const status = err instanceof TaskError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
