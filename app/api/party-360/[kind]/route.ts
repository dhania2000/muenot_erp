import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getFeatureChecker } from "@/lib/permissions"
import { ANCHORS, parsePartyKind, parseSearchQuery } from "@/lib/party-360/model"
import { Party360Error, listParties } from "@/lib/party-360/store"

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { session, tenantId } = auth

  const kind = parsePartyKind((await params).kind)
  if (!kind) return NextResponse.json({ error: "Unknown 360 view" }, { status: 404 })

  const can = await getFeatureChecker(session.userId, session.role)
  const hasView = can(ANCHORS[kind].viewFeature)
  if (!hasView && kind !== "employee") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const search = parseSearchQuery(new URL(request.url).searchParams.get("q"))
  try {
    const items = await listParties(kind, tenantId, {
      search,
      scope: hasView ? "full" : "self",
      viewerUserId: session.userId,
    })
    return NextResponse.json({ items, scope: hasView ? "full" : "self" }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    if (err instanceof Party360Error) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    console.error("[party-360] list failed:", (err as Error).message)
    return NextResponse.json({ error: "Could not load records" }, { status: 500 })
  }
}
