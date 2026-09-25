import { NextResponse } from "next/server"
import { requireTenantOwner } from "@/lib/platform-guard"
import { rollbackChange, SandboxError } from "@/lib/sandbox/service"

/**
 * Roll a deployed change back to its captured pre-promotion production values.
 * Restricted to tenant owners; idempotent via Idempotency-Key.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantOwner()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const changeId = Number(id)
  if (!Number.isInteger(changeId) || changeId <= 0) {
    return NextResponse.json({ error: "Invalid change id" }, { status: 400 })
  }
  const body = await request.json().catch(() => ({}))
  const idempotencyKey =
    request.headers.get("idempotency-key")?.trim() ||
    (typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "") ||
    null
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const result = await rollbackChange(changeId, actor, idempotencyKey)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof SandboxError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error("[v0] sandbox rollback error:", err)
    return NextResponse.json({ error: "Failed to roll back change" }, { status: 500 })
  }
}
