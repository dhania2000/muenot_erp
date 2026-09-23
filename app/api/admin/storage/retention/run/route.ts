import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { runRetentionSweep, getRetentionSummary } from "@/lib/storage/retention"
import { logStorageAudit } from "@/lib/storage/connection-store"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Phase 3. On-demand retention sweep for the current tenant.
 *   POST { dryRun: true }  → preview what WOULD be purged (no deletion).
 *   POST { dryRun: false } → force a real purge now, ignoring the auto switch.
 * Legal-hold files are never deleted in either mode.
 */
async function requireAdmin() {
  const s = await getSession()
  return s && s.role === "admin" ? s : null
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const dryRun = Boolean(body?.dryRun)

  const result = await runRetentionSweep({ dryRun, force: !dryRun })
  if (!dryRun) {
    await logStorageAudit("retention_sweep_run", {
      detail: `deleted=${result.deleted}; skippedLegalHold=${result.skippedLegalHold}; failed=${result.failed}`,
      userId: session.userId,
    })
  }
  const summary = await getRetentionSummary()
  return NextResponse.json({ ok: true, result, summary })
}
