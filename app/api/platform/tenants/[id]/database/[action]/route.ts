import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { recordPlatformAudit } from "@/lib/platform-roles"
import {
  backupTenantDatabase,
  healthCheckTenantDatabase,
  migrateTenantDatabase,
  provisionTenantDatabase,
  type OperationResult,
} from "@/lib/tenant-db/provisioning"
import { TenantRoutingError } from "@/lib/tenant-db/model"

/**
 * Independent per-tenant database lifecycle operations (platform super-admin).
 * ---------------------------------------------------------------------------
 * POST /api/platform/tenants/:id/database/:action  where action is one of
 *   provision | migrate | health | backup
 *
 * provision/migrate/backup are mutating and idempotent: an `Idempotency-Key`
 * header (or `idempotencyKey` in the body) makes a retried request a no-op via
 * the tenant-db audit ledger's unique (tenant, action, key) index. `health` is
 * a read-only probe and needs no key.
 *
 * The connection each operation touches is resolved entirely from trusted
 * server-side tenant state (never from the request body), so a dedicated
 * tenant's operation can only ever reach that tenant's own database.
 */

const ACTIONS = ["provision", "migrate", "health", "backup"] as const
type Action = (typeof ACTIONS)[number]

function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const { id, action } = await params
  const tenantId = Number(id)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: "Invalid tenant id" }, { status: 400 })
  }
  if (!isAction(action)) {
    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
  }

  // Idempotency key: header wins, body is a fallback for clients that cannot set
  // headers. Optional for the read-only health probe.
  let body: any = null
  try {
    body = await req.json()
  } catch {
    body = null
  }
  const idempotencyKey =
    req.headers.get("idempotency-key")?.trim() ||
    (typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "") ||
    null

  const actor = { userId: guard.ctx.userId, email: guard.session.email }

  try {
    let result: OperationResult
    switch (action) {
      case "provision":
        result = await provisionTenantDatabase(tenantId, actor, idempotencyKey)
        break
      case "migrate":
        result = await migrateTenantDatabase(tenantId, actor, idempotencyKey)
        break
      case "backup":
        result = await backupTenantDatabase(tenantId, actor, idempotencyKey)
        break
      case "health":
        result = await healthCheckTenantDatabase(tenantId)
        break
    }

    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: `tenant_db_${action}`,
      targetTenantId: tenantId,
      detail: { status: result.status, ok: result.ok, deduplicated: result.deduplicated },
    })

    // A completed-but-failed operation (e.g. failed provision, unhealthy probe)
    // is a real result, not a client error — surface it as 422 with the detail.
    return NextResponse.json({ result }, { status: result.ok ? 200 : 422 })
  } catch (err: any) {
    if (err instanceof TenantRoutingError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json({ error: "Database operation failed", code: "UNKNOWN_ERROR" }, { status: 500 })
  }
}
