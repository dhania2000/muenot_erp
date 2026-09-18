import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { setModuleRule, getRetentionSummary } from "@/lib/storage/retention"
import { normalizeRetentionRule } from "@/lib/storage/retention-policy"
import { logStorageAudit } from "@/lib/storage/connection-store"

export const runtime = "nodejs"

/**
 * SPEC 36 — Phase 3. Per-module retention override.
 *   POST { module, rule }        → set/replace a module-specific rule.
 *   POST { module, rule: null }  → clear the override (module follows default).
 */
async function requireAdmin() {
  const s = await getSession()
  return s && s.role === "admin" ? s : null
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  const module = String(body.module ?? "").trim()
  if (!module) return NextResponse.json({ error: "Module is required" }, { status: 400 })

  const rule = body.rule === null ? null : normalizeRetentionRule(body.rule)
  await setModuleRule(module, rule)
  await logStorageAudit("retention_module_rule_updated", {
    detail: rule
      ? `${module} → ${rule.mode === "permanent" ? "permanent" : `${rule.amount} ${rule.unit}`}`
      : `${module} → cleared`,
    userId: session.userId,
  })
  const summary = await getRetentionSummary()
  return NextResponse.json({ ok: true, ...summary })
}
