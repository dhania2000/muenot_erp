import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { setConfigValue } from "@/lib/platform-console"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { auditTenantIsolation, IsolationNotReadyError } from "@/lib/tenant-isolation-audit"
import { isolationMode, type IsolationMode } from "@/lib/tenant-guard"

/**
 * Tenant-isolation rollout console (platform super-admin only, audited).
 * ---------------------------------------------------------------------------
 * GET  — current guard mode + a fresh zero-violation audit of every
 *        tenant-owned table.
 * POST — switch the guard mode (off | report | enforce). Switching to
 *        "enforce" is REFUSED (409) unless the audit is clean, which is the
 *        rollout gate: report -> enforce only after a zero-violation audit.
 *
 * The mode is both persisted (setConfigValue, durable across restarts) and
 * applied to process.env in-process so the guard picks it up immediately.
 */
const VALID_MODES: IsolationMode[] = ["off", "report", "enforce"]

export async function GET() {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  try {
    const report = await auditTenantIsolation()
    return NextResponse.json({ mode: isolationMode(), report })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Audit failed" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const mode = String(body?.mode ?? "").toLowerCase() as IsolationMode
  if (!VALID_MODES.includes(mode)) {
    return NextResponse.json({ error: `mode must be one of ${VALID_MODES.join(", ")}` }, { status: 400 })
  }

  try {
    let report = null
    // The rollout gate: never allow enforce until the data is provably isolated.
    if (mode === "enforce") {
      const { assertReadyForEnforce } = await import("@/lib/tenant-isolation-audit")
      report = await assertReadyForEnforce()
    }

    await setConfigValue("TENANT_ISOLATION_MODE", mode)
    // Apply immediately so the guard (which reads process.env) honors the switch
    // without waiting for a redeploy/restart.
    process.env.TENANT_ISOLATION_MODE = mode

    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "config_change",
      detail: { key: "TENANT_ISOLATION_MODE", mode },
    })

    return NextResponse.json({ ok: true, mode, report })
  } catch (err: any) {
    if (err instanceof IsolationNotReadyError) {
      return NextResponse.json(
        { error: err.message, code: "AUDIT_NOT_CLEAN", report: err.report },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: err?.message ?? "Failed to switch isolation mode" }, { status: 400 })
  }
}
