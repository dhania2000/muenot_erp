import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getFeatureChecker } from "@/lib/permissions"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { isIdentityKind, parseIdentityId, type IdentityKind } from "@/lib/identity-registry/model"
import {
  IdentityRegistryError,
  getIdentityLinks,
  listMergeHistory,
  mapIdentity,
  mergeIdentities,
} from "@/lib/identity-registry/store"

const GOVERNANCE_GRANT = "masterdata.change"

function errorResponse(err: unknown) {
  if (err instanceof IdentityRegistryError) {
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status: err.status })
  }
  console.error("[master-data/identities] failed:", (err as Error).message)
  return NextResponse.json({ error: "Could not process identity request" }, { status: 500 })
}

export async function GET(request: Request) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { session, tenantId } = auth

  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(GOVERNANCE_GRANT)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const kindParam = url.searchParams.get("kind")
  const kind = kindParam && isIdentityKind(kindParam) ? (kindParam as IdentityKind) : undefined
  const canonicalId = parseIdentityId(url.searchParams.get("id"))

  try {
    // With kind + id, return the cross-module links for that identity;
    // otherwise the tenant's merge history.
    if (kind && canonicalId != null && url.searchParams.get("view") === "links") {
      const links = await getIdentityLinks(tenantId, kind, canonicalId)
      return NextResponse.json({ kind, id: canonicalId, links }, { headers: { "Cache-Control": "private, no-store" } })
    }
    const history = await listMergeHistory(tenantId, { kind, canonicalId: canonicalId ?? undefined })
    return NextResponse.json({ history }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(request: Request) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { session, tenantId } = auth

  const can = await getFeatureChecker(session.userId, session.role)
  const hasGovernanceGrant = can(GOVERNANCE_GRANT)
  if (!hasGovernanceGrant) {
    await recordAuditLogFromRequest(request, { action: "masterdata.identity.write", result: "denied", entityType: "identity_map" })
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const action = body?.action
  const actor = { userId: session.userId, isAdmin: session.role === "admin", hasGovernanceGrant }

  try {
    if (action === "map") {
      const entry = await mapIdentity(tenantId, {
        kind: body?.kind,
        canonicalId: Number(body?.canonicalId),
        sourceModule: String(body?.sourceModule ?? ""),
        sourceId: Number(body?.sourceId),
        externalRef: body?.externalRef == null ? null : String(body.externalRef),
      })
      await recordAuditLogFromRequest(request, {
        action: "masterdata.identity.map",
        entityType: "identity_map",
        entityLabel: entry.canonicalKey,
        metadata: { kind: entry.kind, sourceModule: entry.sourceModule, sourceId: entry.sourceId },
      })
      return NextResponse.json(entry)
    }

    if (action === "merge") {
      const result = await mergeIdentities(
        tenantId,
        {
          kind: body?.kind,
          survivorId: Number(body?.survivorId),
          mergedId: Number(body?.mergedId),
          survivorAttrs: body?.survivorAttrs ?? {},
          mergedAttrs: body?.mergedAttrs ?? {},
          acknowledgeCollisions: !!body?.acknowledgeCollisions,
          idempotencyKey: String(body?.idempotencyKey ?? ""),
        },
        actor,
      )
      await recordAuditLogFromRequest(request, {
        action: "masterdata.identity.merge",
        entityType: "identity_merge_log",
        entityLabel: `${result.mergedKey} -> ${result.survivorKey}`,
        metadata: {
          survivor: result.survivorKey,
          merged: result.mergedKey,
          collisions: result.collisions.length,
          relinked: result.relinked,
          reused: result.reused,
        },
      })
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (err) {
    return errorResponse(err)
  }
}
