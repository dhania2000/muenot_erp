import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import {
  GOVERNED_KINDS,
  GOV_ACTIONS,
  isGovernedKind,
  listGovernance,
  listChangeRequests,
  setOwnership,
  submitChangeRequest,
  listMaster,
  type GovAction,
} from "@/lib/master-data"
import type { MasterKind } from "@/lib/master-data"

/**
 * SPEC 91 — Master Data Governance API.
 * ---------------------------------------------------------------------------
 * GET  → the governance dashboard for the caller's tenant: which masters are
 *        governed, their governance records, pending/decided change requests,
 *        and (when `?kind=` is given) the canonical values of that master so the
 *        UI can show ungoverned-vs-governed side by side.
 * POST → submit a maker change request (create/update/deactivate/reactivate/archive).
 * PUT  → assign the data owner + approval authority for a governed value.
 *
 * Every route is gated by tenant-admin authority over the EFFECTIVE tenant, so a
 * platform operator only reaches a customer's governance while impersonating.
 */

function parseKind(raw: string | null): MasterKind | null {
  if (!raw) return null
  if (!isGovernedKind(raw as MasterKind)) return null
  return raw as MasterKind
}

export async function GET(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const kindParam = req.nextUrl.searchParams.get("kind")
  const kind = parseKind(kindParam)
  if (kindParam && !kind) {
    return NextResponse.json({ error: `"${kindParam}" is not a governed master.` }, { status: 400 })
  }

  const [records, requests, values] = await Promise.all([
    listGovernance(tenantId, kind ? { kind } : {}),
    listChangeRequests(tenantId, kind ? { kind } : {}),
    kind ? listMaster(kind, { tenantId, activeOnly: false }) : Promise.resolve(null),
  ])

  return NextResponse.json({
    governedKinds: [...GOVERNED_KINDS],
    records,
    requests,
    values,
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const kind = parseKind(String(body?.kind ?? ""))
  if (!kind) return NextResponse.json({ error: "A governed master kind is required." }, { status: 400 })
  const code = String(body?.code ?? "").trim()
  if (!code) return NextResponse.json({ error: "A value code is required." }, { status: 400 })
  const action = String(body?.action ?? "") as GovAction
  if (!GOV_ACTIONS.includes(action)) {
    return NextResponse.json({ error: "A valid change action is required." }, { status: 400 })
  }

  try {
    const request = await submitChangeRequest(
      tenantId,
      {
        kind,
        code,
        action,
        payload: body?.payload && typeof body.payload === "object" ? body.payload : undefined,
        effectiveDate: body?.effectiveDate ? String(body.effectiveDate) : null,
        comment: body?.comment ? String(body.comment) : null,
      },
      guard.session.userId,
    )
    return NextResponse.json({ ok: true, request })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const kind = parseKind(String(body?.kind ?? ""))
  if (!kind) return NextResponse.json({ error: "A governed master kind is required." }, { status: 400 })
  const code = String(body?.code ?? "").trim()
  if (!code) return NextResponse.json({ error: "A value code is required." }, { status: 400 })

  try {
    const record = await setOwnership(
      tenantId,
      kind,
      code,
      {
        ownerId:
          body?.ownerId === null || body?.ownerId === undefined || body?.ownerId === ""
            ? null
            : Number(body.ownerId),
        approvalAuthority:
          body?.approvalAuthority === null || body?.approvalAuthority === ""
            ? null
            : body?.approvalAuthority !== undefined
              ? String(body.approvalAuthority)
              : undefined,
      },
      guard.session.userId,
    )
    return NextResponse.json({ ok: true, record })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
