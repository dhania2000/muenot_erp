import { NextResponse } from "next/server"
import { isDataScopeKind, type DataScopeKind } from "@/lib/data-scope-model"
import {
  getUserAssignments,
  getUserScopeMap,
  setUserAssignments,
  setUserScopeGrants,
} from "@/lib/data-scope-store"
import { requireAdminTenant } from "../route"

/** A user's current per-domain grants + entity/branch assignments. */
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { userId } = await params
  const uid = Number(userId)
  if (!Number.isFinite(uid)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 })

  const [grants, assignments] = await Promise.all([
    getUserScopeMap(ctx.tenantId, uid),
    getUserAssignments(ctx.tenantId, uid),
  ])
  return NextResponse.json({ grants, assignments })
}

/** Replace a user's grants + assignments. */
export async function PUT(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { userId } = await params
  const uid = Number(userId)
  if (!Number.isFinite(uid)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  // Only keep valid domain → kind pairs; the store further ignores unknown domains.
  const grants: Record<string, DataScopeKind> = {}
  if (body.grants && typeof body.grants === "object") {
    for (const [domain, kind] of Object.entries(body.grants)) {
      if (isDataScopeKind(kind)) grants[domain] = kind
    }
  }

  await setUserScopeGrants(ctx.tenantId, uid, grants, ctx.session.userId)
  await setUserAssignments(ctx.tenantId, uid, {
    entities: Array.isArray(body.assignments?.entities) ? body.assignments.entities : [],
    branches: Array.isArray(body.assignments?.branches) ? body.assignments.branches : [],
  })

  return NextResponse.json({ ok: true })
}
