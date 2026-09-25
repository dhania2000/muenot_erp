import "server-only"
/**
 * Thin metering/enforcement helpers for wiring usage into real backend send
 * paths (storage, WhatsApp, SMS, voice, API, AI, automation).
 *
 * These wrap the primitives in `usage-metering.ts` with a tenant-binding guard
 * so they are safe to call from choke points that may (WhatsApp store, storage
 * facade, app route handlers) or may not (the public `/api/v1` pipeline, cron
 * workers) run inside a bound tenant scope. When no tenant is bound, callers
 * that know their tenant should pass it explicitly via `tenantId`; otherwise the
 * call is a no-op instead of throwing.
 */
import { currentTenantIdOrNull, runForTenant } from "@/lib/tenant-scope"
import {
  recordUsage,
  recordUsageSafe,
  enforceUsageLimit,
  UsageLimitError,
  type RecordUsageInput,
  type LimitCheck,
} from "@/lib/billing/usage-metering"

/**
 * Record a metered event. When a tenant is already bound in context this is a
 * fire-and-forget call; when `tenantId` is supplied (system entry points with
 * no session, e.g. the public API pipeline or a cron worker) the event is
 * recorded under that tenant explicitly. Never throws into the caller.
 */
export function meterUsage(input: RecordUsageInput & { tenantId?: number }): void {
  const { tenantId, ...rest } = input
  if (tenantId != null) {
    void runForTenant({ tenantId }, () => recordUsage(rest)).catch((err) =>
      console.error("[v0] meterUsage failed:", err),
    )
    return
  }
  if (currentTenantIdOrNull() == null) return
  recordUsageSafe(rest)
}

/**
 * Enforce a HARD quota before a metered backend action. Returns the limit check
 * (so callers can also surface a soft-limit "warning"/"over" status) or `null`
 * when no tenant is bound and none is supplied. Throws `UsageLimitError` when a
 * hard limit would be exceeded so the caller can map it to a 402/429.
 */
export async function enforceUsageIfScoped(
  meterKey: string,
  amount = 1,
  tenantId?: number,
): Promise<LimitCheck | null> {
  if (tenantId != null) {
    return runForTenant({ tenantId }, () => enforceUsageLimit(meterKey, amount))
  }
  if (currentTenantIdOrNull() == null) return null
  return enforceUsageLimit(meterKey, amount)
}

export { UsageLimitError }
