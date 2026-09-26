/**
 * Spec46 — request-level write lock used by middleware. Edge-safe: no DB.
 * The tenant's write state comes from the token-guarded internal feed
 * (/api/billing/access-state), cached per tenant per isolate.
 *
 * Failure policy mirrors the maintenance gate: if the feed is unreachable the
 * gate fails OPEN (a lookup failure must never lock every tenant out), and the
 * subscription engine still refuses plan changes on non-writable subscriptions.
 */
import { NextResponse, type NextRequest } from "next/server"
import { BILLING_GATE_HEADER, billingWriteLockToken } from "@/lib/maintenance/gate-token"
import {
  WRITE_LOCK_CODE,
  WRITE_LOCK_STATUS,
  shouldCheckWriteLock,
  type WriteAccessState,
} from "@/lib/billing/write-lock-model"

const TTL_MS = 15_000
const cache = new Map<number, { at: number; state: WriteAccessState }>()

type Fetcher = typeof fetch

export function __resetWriteLockCache(): void {
  cache.clear()
}

async function loadState(origin: string, tenantId: number, doFetch: Fetcher): Promise<WriteAccessState | null> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.state
  try {
    const token = await billingWriteLockToken(process.env.SESSION_SECRET)
    if (!token) return null
    const res = await doFetch(`${origin}/api/billing/access-state?tenantId=${tenantId}`, {
      headers: { [BILLING_GATE_HEADER]: token },
      cache: "no-store",
    })
    if (!res.ok) return hit?.state ?? null
    const state = (await res.json()) as WriteAccessState
    if (cache.size > 5000) cache.clear()
    cache.set(tenantId, { at: Date.now(), state })
    return state
  } catch {
    return hit?.state ?? null
  }
}

/** Returns a 423 response for a locked tenant's mutation, or null to continue. */
export async function billingWriteLockGate(
  request: NextRequest,
  subject: { tenantId: number | null; platformRole?: string | null },
  requestId: string,
  doFetch: Fetcher = fetch,
): Promise<NextResponse | null> {
  const { pathname } = request.nextUrl
  if (!subject.tenantId) return null
  if (!shouldCheckWriteLock({ method: request.method, pathname, platformRole: subject.platformRole })) return null
  const state = await loadState(request.nextUrl.origin, subject.tenantId, doFetch)
  if (!state || state.writable) return null
  return NextResponse.json(
    {
      error: state.reason ?? "Your subscription does not allow changes right now.",
      code: WRITE_LOCK_CODE,
      subscriptionStatus: state.status,
      requestId,
    },
    { status: WRITE_LOCK_STATUS, headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
  )
}
