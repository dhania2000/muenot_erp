import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { authorizeRiskRequest } from "@/lib/risk-compliance/access"
import { computeRiskComplianceDashboard, maskDashboard } from "@/lib/risk-compliance/aggregate"
import { scopeKeyOf } from "@/lib/risk-compliance/scope"

/**
 * POST /api/admin/risk-compliance/refresh — recompute and cache a snapshot.
 * Idempotent per (tenant, Idempotency-Key): a retry replays the stored snapshot;
 * reusing a key for a different scope is a 409. Audited on real writes only.
 */

const IDEM_RE = /^[A-Za-z0-9._:-]{8,100}$/

function parsePayload(raw: unknown) {
  return typeof raw === "string" ? JSON.parse(raw) : raw
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const access = await authorizeRiskRequest(body?.level, body?.value)
  if (!access.ok) return access.response
  const { tenantId, userId, isOwner, resolved } = access
  const scope = resolved.scope
  const scopeKey = scopeKeyOf(scope)
  const present = (d: any) => (isOwner ? d : maskDashboard(d))

  const rawKey = req.headers.get("idempotency-key") ?? (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : null)
  if (rawKey != null && !IDEM_RE.test(rawKey)) {
    return NextResponse.json({ error: "Invalid Idempotency-Key (8-100 chars: A-Z a-z 0-9 . _ : -)" }, { status: 400 })
  }
  const idempotencyKey = rawKey || null

  const findExisting = () =>
    query<any[]>(
      `SELECT scope_key, payload FROM risk_compliance_snapshots WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    )
  const replay = (row: any) =>
    row.scope_key !== scopeKey
      ? NextResponse.json({ error: "Idempotency-Key already used for a different scope" }, { status: 409 })
      : NextResponse.json({ ok: true, replayed: true, dashboard: present(parsePayload(row.payload)) })

  try {
    if (idempotencyKey) {
      const existing = await findExisting()
      if (existing.length) return replay(existing[0])
    }

    const dash = await computeRiskComplianceDashboard(tenantId, scope)
    try {
      await query(
        `INSERT INTO risk_compliance_snapshots (tenant_id, scope_key, payload, computed_at, computed_by, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tenantId, scopeKey, JSON.stringify(dash), new Date(dash.computedAt), userId, idempotencyKey],
      )
    } catch (err: any) {
      // Concurrent retry won the unique (tenant_id, idempotency_key) race.
      if (idempotencyKey && (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062)) {
        const existing = await findExisting()
        if (existing.length) return replay(existing[0])
      }
      throw err
    }

    await recordAuditLogFromRequest(req, {
      action: "risk_compliance.refresh",
      entityType: "risk_compliance_snapshot",
      entityId: scopeKey,
      metadata: {
        scope,
        narrowed: resolved.narrowed,
        openItems: dash.totals.openItems,
        sourcesAvailable: dash.totals.sourcesAvailable,
        sourcesMissing: dash.totals.sourcesMissing,
      },
    })

    return NextResponse.json({ ok: true, replayed: false, dashboard: present(dash) })
  } catch (err) {
    console.error("[risk-compliance] refresh failed:", (err as Error)?.message)
    return NextResponse.json({ error: "Failed to refresh" }, { status: 500 })
  }
}
