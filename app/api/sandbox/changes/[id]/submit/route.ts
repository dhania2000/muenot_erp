import { NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { submitChange, SandboxError } from "@/lib/sandbox/service"

/** Route a draft change into the review/approval engine. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const changeId = Number(id)
  if (!Number.isInteger(changeId) || changeId <= 0) {
    return NextResponse.json({ error: "Invalid change id" }, { status: 400 })
  }
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    return NextResponse.json({ change: await submitChange(changeId, actor) })
  } catch (err) {
    if (err instanceof SandboxError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error("[v0] sandbox submit error:", err)
    return NextResponse.json({ error: "Failed to submit change" }, { status: 500 })
  }
}
