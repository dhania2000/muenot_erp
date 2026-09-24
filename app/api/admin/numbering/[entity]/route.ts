import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { deleteRule } from "@/lib/numbering/store"
import { allocateNumber, peekNext, resetCounter } from "@/lib/numbering/engine"
import { normalizeEntity } from "@/lib/numbering/model"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ entity: string }> }

/** GET → a non-consuming preview of the next number for this entity. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { entity } = await ctx.params
  try {
    const preview = await peekNext(normalizeEntity(entity))
    return NextResponse.json({ preview })
  } catch (err) {
    console.error("[admin/numbering/:entity] preview failed:", err)
    return NextResponse.json({ error: "Failed to preview number" }, { status: 500 })
  }
}

/**
 * POST → run an engine action against this entity.
 *   { action: "allocate" } consumes and returns the next real number.
 *   { action: "reset", periodKey? } restarts the sequence.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { entity } = await ctx.params
  const key = normalizeEntity(entity)

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    // An empty body is allowed; default action below.
  }
  const action = String(body?.action ?? "allocate")

  try {
    if (action === "allocate") {
      const allocation = await allocateNumber(key)
      return NextResponse.json({ ok: true, allocation })
    }
    if (action === "reset") {
      const cleared = await resetCounter(key, body?.periodKey ? String(body.periodKey) : undefined)
      return NextResponse.json({ ok: true, cleared })
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (err) {
    console.error("[admin/numbering/:entity] action failed:", err)
    return NextResponse.json({ error: "Numbering action failed" }, { status: 500 })
  }
}

/** DELETE → remove the tenant's custom rule, reverting the entity to its default. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { entity } = await ctx.params
  try {
    const removed = await deleteRule(normalizeEntity(entity))
    return NextResponse.json({ ok: true, removed })
  } catch (err) {
    console.error("[admin/numbering/:entity] delete failed:", err)
    return NextResponse.json({ error: "Failed to delete numbering rule" }, { status: 500 })
  }
}
