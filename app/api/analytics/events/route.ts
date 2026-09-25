import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { normalizeEventBatch } from "@/lib/customer-success/model"
import { recordUsageEvents } from "@/lib/customer-success/store"
import { NO_STORE, csErrorResponse, readJson } from "@/lib/customer-success/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Spec31 — ingest privacy-aware feature/module usage events for the caller's
 * own tenant. Tenant and actor come from the verified session only; only
 * module/feature/action/clientEventId/occurredAt are read from the body.
 * Platform operators acting through impersonation are never counted.
 */
export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401, headers: NO_STORE })
  const tenantId = Number(session.tenantId)
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) {
    return NextResponse.json({ error: "No tenant in context" }, { status: 403, headers: NO_STORE })
  }
  try {
    const events = normalizeEventBatch(await readJson(req), new Date())
    if (session.impersonatedTenantId) {
      return NextResponse.json({ accepted: 0, duplicates: 0, dropped: events.length, reason: "impersonation" }, { status: 202, headers: NO_STORE })
    }
    const result = await recordUsageEvents({ tenantId, userId: session.userId, events })
    return NextResponse.json(result, { status: 202, headers: NO_STORE })
  } catch (err) {
    return csErrorResponse(err, "Failed to record usage events")
  }
}
