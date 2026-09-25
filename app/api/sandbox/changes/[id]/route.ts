import { NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { getChangeDetail, SandboxError } from "@/lib/sandbox/service"

/** Full detail for a single configuration change (diff, approver, deploy state). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const changeId = Number(id)
  if (!Number.isInteger(changeId) || changeId <= 0) {
    return NextResponse.json({ error: "Invalid change id" }, { status: 400 })
  }
  try {
    return NextResponse.json({ change: await getChangeDetail(changeId) })
  } catch (err) {
    if (err instanceof SandboxError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    return NextResponse.json({ error: "Failed to load change" }, { status: 500 })
  }
}
