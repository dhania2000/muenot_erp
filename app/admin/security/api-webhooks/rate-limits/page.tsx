import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { SecurityHeading } from "@/components/security/security-ui"
import { RateLimitsClient } from "@/components/security/rate-limits-client"

export const dynamic = "force-dynamic"

// SPEC 53 — Rate limit monitoring UI. Limits are plan-derived and enforced on
// every /api/v1/* request by lib/api-platform/handler.ts; this screen surfaces
// the enforced tier plus live usage and blocked-request telemetry.
export default async function RateLimitsPage() {
  const session = await getSession()
  if (!session || session.role !== "admin") redirect("/dashboard")

  return (
    <div className="space-y-6">
      <SecurityHeading title="Rate limits" spec="Spec 53">
        Plan-tiered request ceilings enforced on every public API call — with live usage and blocked-request
        telemetry.
      </SecurityHeading>

      <RateLimitsClient />
    </div>
  )
}
