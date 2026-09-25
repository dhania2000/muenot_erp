import type { Metadata } from "next"
import { SecurityHeading } from "@/components/security/security-ui"
import { AlertsClient } from "@/components/security/alerts-client"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Security alerts — Login protection",
  description:
    "Correlated login-protection alerts: failed-login bursts, new admins, role changes, API-key creation and breached passwords, with progressive lockout and session revocation on critical compromise.",
}

export default function SecurityAlertsPage() {
  return (
    <div className="flex flex-col gap-6">
      <SecurityHeading title="Security alerts" spec="SPEC 22 · #37, #215">
        Login protection and security alerts. Signals across failed logins, new administrators, role changes and API-key
        creation are correlated into deduplicated, actionable alerts. A critical compromise enforces progressive lockout
        and revokes the account&apos;s sessions automatically.
      </SecurityHeading>
      <AlertsClient />
    </div>
  )
}
