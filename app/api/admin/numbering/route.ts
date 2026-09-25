import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { listRules, saveRule } from "@/lib/numbering/store"
import {
  NUMBERING_ENTITIES,
  NUMBERING_TOKENS,
  RESET_POLICIES,
  DEFAULT_FISCAL_START_MONTH,
} from "@/lib/numbering/model"

export const dynamic = "force-dynamic"

/**
 * SPEC 92 — Numbering Engine admin API.
 * GET  → the configurable entity catalogue, format tokens, reset policies and
 *        the tenant's current effective rules (each with a rendered sample).
 */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  try {
    const items = await listRules()
    const rules = items.map((i) => ({
      ...i.rule,
      entity: i.entity,
      label: i.label,
      module: i.module,
      custom: i.custom,
      active: i.active,
      sample: i.sample,
    }))
    return NextResponse.json({
      rules,
      catalogue: NUMBERING_ENTITIES.map((e) => ({
        entity: e.entity,
        label: e.label,
        module: e.module,
        defaults: e.defaults,
      })),
      tokens: NUMBERING_TOKENS,
      resetPolicies: RESET_POLICIES,
      fiscalStartMonthDefault: DEFAULT_FISCAL_START_MONTH,
    })
  } catch (err) {
    console.error("[admin/numbering] list failed:", err)
    return NextResponse.json({ error: "Failed to load numbering rules" }, { status: 500 })
  }
}

/** POST → create or update a numbering rule for an entity. */
export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    const result = await saveRule(
      {
        entity: String(body?.entity ?? ""),
        prefix: body?.prefix,
        suffix: body?.suffix,
        padding: body?.padding,
        reset: body?.reset,
        format: body?.format,
        fiscalStartMonth: body?.fiscalStartMonth,
        startNumber: body?.startNumber,
        active: body?.active,
      },
      guard.session.userId ?? null,
    )
    if (!result.ok) return NextResponse.json({ error: result.errors.join(" ") }, { status: 400 })
    return NextResponse.json({ ok: true, rule: result.rule })
  } catch (err) {
    console.error("[admin/numbering] save failed:", err)
    return NextResponse.json({ error: "Failed to save numbering rule" }, { status: 500 })
  }
}
