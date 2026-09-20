import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { listLifecycleUsers } from "@/lib/user-lifecycle"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { TemporaryAccessClient } from "./temporary-access-client"

export const dynamic = "force-dynamic"

// SPEC 64 — Temporary access. Granting and revoking a time-boxed access
// expiry per user IS real and enforced: lib/user-lifecycle.ts stores
// accessExpiresAt and /api/admin/users/[id] exposes grant_temp_access /
// revoke_temp_access. What's not yet built is automatic enforcement at
// sign-in when the expiry passes, and a reason/approval trail — see the
// banner below.
export default async function TemporaryAccessPage() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>
  const tenantId = effectiveTenantId(guard.ctx)
  const users = tenantId != null ? await listLifecycleUsers(tenantId) : []
  const active = users
    .filter((u) => u.lifecycleState === "active")
    .map((u) => ({ id: u.id, name: u.name, email: u.email, tenantRole: u.tenantRole, accessExpiresAt: u.accessExpiresAt }))

  return (
    <div className="space-y-6">
      <SecurityHeading title="Temporary access" spec="Spec 64">
        Grant a user access that automatically expires on a chosen date, or revoke an existing grant early.
      </SecurityHeading>

      <BackendStatus level="partial">
        Granting and revoking a time-boxed expiry is real and stored per user. Not yet built: automatic sign-in
        enforcement once the expiry passes (a user with an expired grant is not yet blocked at login), and a
        required reason/approval trail for the grant.
      </BackendStatus>

      <TemporaryAccessClient initialUsers={active} />
    </div>
  )
}
