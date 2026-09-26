import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getFeatureChecker } from "@/lib/permissions"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { enforceFieldSecurity, fieldSecurityActorFromSession } from "@/lib/field-security"
import { ANCHORS, decideAccess, parsePartyId, parsePartyKind } from "@/lib/party-360/model"
import { Party360Error, buildParty360, loadAnchorRow } from "@/lib/party-360/store"

export async function GET(request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { session, tenantId } = auth

  const { kind: rawKind, id: rawId } = await params
  const kind = parsePartyKind(rawKind)
  if (!kind) return NextResponse.json({ error: "Unknown 360 view" }, { status: 404 })
  const id = parsePartyId(rawId)
  if (id == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const can = await getFeatureChecker(session.userId, session.role)
  const hasView = can(ANCHORS[kind].viewFeature)
  // Only employees may fall back to a self scope; everyone else without the
  // base permission is rejected before any record is read.
  if (!hasView && kind !== "employee") {
    await recordAuditLogFromRequest(request, {
      action: `party360.${kind}.view`, result: "denied", entityType: ANCHORS[kind].table, entityId: id,
    })
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const { ctx, row } = await loadAnchorRow(kind, tenantId, id)
    const scope = row ? decideAccess(kind, hasView, { viewerUserId: session.userId, recordUserId: row.user_id }) : null
    if (!row || !scope) {
      // Same response for "other tenant", "missing" and "not yours" so the
      // endpoint never confirms a record exists outside the viewer's scope.
      if (!hasView) {
        await recordAuditLogFromRequest(request, {
          action: `party360.${kind}.view`, result: "denied", entityType: ANCHORS[kind].table, entityId: id,
        })
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      return NextResponse.json({ error: `${ANCHORS[kind].label} not found` }, { status: 404 })
    }

    const view = await buildParty360({ kind, tenantId, row, ctx, scope, can })

    const actor = await fieldSecurityActorFromSession(session).catch(() => null)
    if (actor) {
      const fs = ANCHORS[kind].fieldSecurity
      const { rows, applied } = await enforceFieldSecurity([view.profile], { tenantId, module: fs.module, entity: fs.entity, actor })
      view.profile = rows[0] as Record<string, unknown>
      for (const a of applied) if (!view.maskedFields.includes(a.field)) view.maskedFields.push(a.field)
    }

    await recordAuditLogFromRequest(request, {
      action: `party360.${kind}.view`,
      entityType: ANCHORS[kind].table,
      entityId: id,
      entityLabel: view.name,
      metadata: {
        scope,
        maskedFields: view.maskedFields,
        sections: Object.fromEntries(view.sections.map((s) => [s.key, s.status])),
        duplicates: view.duplicates.length,
      },
    })

    return NextResponse.json(view, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    if (err instanceof Party360Error) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    console.error("[party-360] detail failed:", (err as Error).message)
    return NextResponse.json({ error: "Could not load 360 view" }, { status: 500 })
  }
}
