import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { RateLimitsClient } from "@/components/security/rate-limits-client"

export const dynamic = "force-dynamic"

// SPEC 53 — Rate limit configuration UI.
export default async function RateLimitsPage() {
  const session = await getSession()
  if (!session || session.role !== "admin") redirect("/dashboard")

  return (
    <div className="space-y-6">
      <SecurityHeading title="Rate limits" spec="Spec 53">
        Per-scope request ceilings for the public API — tenant, API key, and endpoint.
      </SecurityHeading>

      <BackendStatus level="planned">
        Enforcement middleware for the public API does not exist yet, so rules configured here are a preview only
        and are not applied to real traffic. Current usage and remaining-request figures will populate once Codex
        wires request metering into the API layer.
      </BackendStatus>

      <RateLimitsClient />
    </div>
  )
}
