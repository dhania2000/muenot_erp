import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { listLifecycleUsers } from "@/lib/user-lifecycle"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { PasswordPolicyEditor } from "@/components/security/password-policy-editor"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export const dynamic = "force-dynamic"

// SPEC 60 — Password management. Hashing, the admin-initiated "reset now,
// force change at next login" flow, and the configurable policy below
// (min length, complexity, expiry, reuse history, lockout threshold, reset
// token expiry, session invalidation on password change) are all enforced by
// the backend — see lib/password-policy.ts and lib/auth.ts.
export default async function PasswordPage() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>
  const tenantId = effectiveTenantId(guard.ctx)
  const users = tenantId != null ? await listLifecycleUsers(tenantId) : []
  const active = users.filter((u) => u.lifecycleState === "active")
  const pendingChange = active.filter((u) => u.mustChangePassword)

  return (
    <div className="space-y-6">
      <SecurityHeading title="Password management" spec="Spec 60">
        Passwords are always stored hashed. An admin can reset any user&apos;s password now, which issues a
        one-time temporary password and forces a change at next login.
      </SecurityHeading>

      <BackendStatus level="live">
        Hashing (bcrypt), login throttling, account lockout, password history, reset-token expiration, and
        session invalidation after a password change are all enforced today. Update the policy below and it
        applies immediately to registration, sign-in, self-service change, and password reset.
      </BackendStatus>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Active users</CardDescription>
            <CardTitle className="text-2xl">{active.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Must change at next login</CardDescription>
            <CardTitle className="text-2xl">{pendingChange.length}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <PasswordPolicyEditor />
    </div>
  )
}
