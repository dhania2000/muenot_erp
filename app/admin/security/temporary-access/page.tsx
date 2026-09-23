import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { listLifecycleUsers } from "@/lib/user-lifecycle"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { TemporaryAccessClient } from "./temporary-access-client"

export const dynamic = "force-dynamic"

// SPEC 64 — Temporary access. Fully backed and enforced: grants are stored in
// `temporary_access_grants` (lib/temporary-access-store.ts) with user, optional
// role elevation, scope, start/expiry, reason and approver. Role elevations
// change `users.tenant_role` (re-resolved by every request guard) and the
// access window is written to `users.access_expires_at` (blocked at login by
// evaluateLogin). Scheduled starts and automatic revocation at expiry are
// driven by the allow-listed cron job /api/cron/temporary-access.
export default async function TemporaryAccessPage() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>
  const tenantId = effectiveTenantId(guard.ctx)
  const users = tenantId != null ? await listLifecycleUsers(tenantId) : []
  const active = users
    .filter((u) => u.lifecycleState === "active")
    .map((u) => ({ id: u.id, name: u.name, email: u.email, tenantRole: u.tenantRole }))

  return (
    <div className="space-y-6">
      <SecurityHeading title="Temporary access" spec="Spec 64">
        Grant a user a time-boxed access window and/or role elevation with a required reason and approver. Access
        starts immediately or on a schedule and is revoked automatically at expiry.
      </SecurityHeading>

      <BackendStatus level="live">
        Grants are stored and enforced: a temporary role elevation changes the user&apos;s role (honored by every
        request), and the access window blocks sign-in once it passes. Scheduled activation and automatic revocation
        at expiry run on a background scheduler; grants can also be revoked early here.
      </BackendStatus>

      <TemporaryAccessClient initialUsers={active} />
    </div>
  )
}
