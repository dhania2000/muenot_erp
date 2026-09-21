import { requireTenantAdmin } from "@/lib/platform-guard"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { EmergencyAccessPanel } from "@/components/security/emergency-access-panel"

export const dynamic = "force-dynamic"

// SPEC 65 — Emergency ("break-glass") access. There is no server-enforced,
// elevated, time-boxed access path that bypasses normal role checks — every
// request still goes through the standard tenant-admin guard in
// lib/platform-guard.ts. The workflow below (request, auto-approve for demo,
// active countdown, revoke, history) is fully interactive but frontend-only
// state (see lib/emergency-access-store.ts). Codex will replace it with a
// real, server-enforced elevated session and approval step.
export default async function EmergencyAccessPage() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>

  return (
    <div className="space-y-6">
      <SecurityHeading title="Emergency access" spec="Spec 65">
        Break-glass access for incidents: request temporary elevated permissions with mandatory justification,
        automatic time-boxed expiry, and a full audit trail.
      </SecurityHeading>

      <BackendStatus level="planned">
        There is no break-glass path enforced by the backend today — every request still goes through the
        standard role guard, with no bypass or auto-revoke timer. The workflow below is fully interactive so the
        experience can be reviewed end-to-end, but it only affects local browser state until that backend exists.
      </BackendStatus>

      <EmergencyAccessPanel currentUser={guard.ctx.user?.name ?? guard.ctx.user?.email ?? "Signed-in admin"} />
    </div>
  )
}
