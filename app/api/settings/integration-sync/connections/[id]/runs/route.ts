import { type NextRequest, NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getSyncConnection, listSyncLog, listSyncRuns } from "@/lib/integration-sync/store"

/**
 * Spec16 — run history + immutable log for one connection (#90-91).
 * Read-only; any tenant member. Tenant-scoped: a connection id belonging to
 * another tenant resolves to 404, so run/log rows can never leak across tenants.
 */
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid connection id" }, { status: 400 })

  const connection = await getSyncConnection(auth.tenantId, id)
  if (!connection) return NextResponse.json({ error: "Sync connection not found" }, { status: 404 })

  const url = new URL(req.url)
  const limit = Number(url.searchParams.get("limit")) || undefined
  const includeLog = url.searchParams.get("log") === "1"
  const runId = Number(url.searchParams.get("runId")) || undefined

  const runs = await listSyncRuns(auth.tenantId, id, limit)
  if (!includeLog) return NextResponse.json({ runs })
  const log = await listSyncLog(auth.tenantId, id, { runId, limit })
  return NextResponse.json({ runs, log })
}
