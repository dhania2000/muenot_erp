import { KeyRound } from "lucide-react"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { listLifecycleUsers } from "@/lib/user-lifecycle"
import { SecurityHeading, FieldSpec, FieldSpecGrid } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export const dynamic = "force-dynamic"

// SPEC 60 — Password management. Hashing and the admin-initiated "reset now,
// force change at next login" flow are real (lib/user-lifecycle.ts adminResetPassword,
// wired through the admin user directory). A configurable, enforced password POLICY
// (min length, complexity, expiry, reuse history, lockout threshold) is not yet stored
// or checked anywhere — that's the gap this screen is honest about.
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

      <BackendStatus level="partial">
        Hashing (bcrypt) and admin-initiated resets are real and enforced today — reset from Admin → Users. A
        configurable tenant policy (minimum length, complexity rules, expiry, reuse history, lockout after failed
        attempts) is not yet stored or checked at sign-in. The fields below show what that policy screen will
        manage once it exists.
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

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Password policy</CardTitle>
          </div>
          <CardDescription>Spec 60 — not yet enforced at sign-in or sign-up.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSpecGrid>
            <FieldSpec label="Minimum length" />
            <FieldSpec label="Require upper &amp; lower case" />
            <FieldSpec label="Require a number" />
            <FieldSpec label="Require a symbol" />
            <FieldSpec label="Expiry period" hint="e.g. 90 days" />
            <FieldSpec label="Reuse history" hint="e.g. last 5 passwords" />
            <FieldSpec label="Failed attempt lockout threshold" />
            <FieldSpec label="Lockout duration" />
            <FieldSpec label="Temporary password expiry" hint="Currently: none — set at reset time" />
          </FieldSpecGrid>
        </CardContent>
      </Card>
    </div>
  )
}
