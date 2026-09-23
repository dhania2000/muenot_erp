import { requireTenantAdmin } from "@/lib/platform-guard"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { EmergencyAccessPanel } from "@/components/security/emergency-access-panel"

export const dynamic = "force-dynamic"

// Emergency ("break-glass") access. Server-enforced and audited: a
// request creates a pending grant (lib/temporary-access-store.ts) that a
// DIFFERENT administrator must explicitly approve. On approval the requester's
// role is elevated for a time-boxed window (honored by every request guard),
// a persistent app-wide banner is shown ("no silent usage"), and the grant is
// revoked automatically at expiry by /api/cron/temporary-access. Every state
// change is written to the security audit trail and notifies admins.
export default async function EmergencyAccessPage() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>

  return (
    <div className="space-y-6">
      <SecurityHeading title="Emergency access" spec="">
        Break-glass access for incidents: request temporary elevated permissions with mandatory justification, a
        second administrator&apos;s approval, automatic time-boxed expiry, and a full audit trail.
      </SecurityHeading>

      <BackendStatus level="live">
        Break-glass access is enforced end-to-end: a request must be approved by a second administrator, the
        approved elevation changes the user&apos;s role for a time-boxed window, a persistent banner is shown while
        active, and access is revoked automatically at expiry. Every step is audited.
      </BackendStatus>

      <EmergencyAccessPanel />
    </div>
  )
}
