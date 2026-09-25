import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { listSyncConflicts } from "@/lib/integration-sync/store"

/**
 * Spec16 — list conflicts for the tenant (#90-91). Read-only; any tenant member.
 * Optional `connectionId` and `status` (open|resolved) filters. Always scoped to
 * the acting tenant.
 */
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const url = new URL(req.url)
  const connectionId = Number(url.searchParams.get("connectionId")) || undefined
  const statusRaw = url.searchParams.get("status")
  const status = statusRaw === "open" || statusRaw === "resolved" ? statusRaw : undefined
  const limit = Number(url.searchParams.get("limit")) || undefined
  const conflicts = await listSyncConflicts(auth.tenantId, { connectionId, status, limit })
  return NextResponse.json({ conflicts })
}
