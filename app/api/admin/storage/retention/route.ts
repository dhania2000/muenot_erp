import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getRetentionSummary, setRetentionSettings } from "@/lib/storage/retention"
import { normalizeRetentionRule } from "@/lib/storage/retention-policy"
import { logStorageAudit } from "@/lib/storage/connection-store"

export const runtime = "nodejs"

/**
 * Phase 3. Tenant retention configuration.
 *   GET  → the full retention summary (settings, module rules, file counts).
 *   POST → save the default rule and/or the auto-cleanup switch.
 */
async function requireAdmin() {
  const s = await getSession()
  return s && s.role === "admin" ? s : null
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const summary = await getRetentionSummary()
  return NextResponse.json(summary)
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  const input: { defaultRule?: ReturnType<typeof normalizeRetentionRule>; autoCleanupEnabled?: boolean } = {}
  if (body.defaultRule !== undefined) input.defaultRule = normalizeRetentionRule(body.defaultRule)
  if (body.autoCleanupEnabled !== undefined) input.autoCleanupEnabled = Boolean(body.autoCleanupEnabled)

  const saved = await setRetentionSettings(input)
  await logStorageAudit("retention_settings_updated", {
    detail: `default=${saved.defaultRule.mode === "permanent" ? "permanent" : `${saved.defaultRule.amount} ${saved.defaultRule.unit}`}; autoCleanup=${saved.autoCleanupEnabled}`,
    userId: session.userId,
  })
  const summary = await getRetentionSummary()
  return NextResponse.json({ ok: true, ...summary })
}
