import { ShieldCheck, Users } from "lucide-react"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { listLifecycleUsers } from "@/lib/user-lifecycle"
import { SecurityHeading, FieldSpec, FieldSpecGrid } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

// SPEC 59 — MFA (TOTP) enrollment. Enrollment itself is real (lib/user-lifecycle.ts,
// wired through /api/auth/mfa for self-service and the admin "reset_mfa" action in
// /api/admin/users/[id]). What is NOT enforced yet is a tenant-wide policy — nothing
// requires enrollment, so this screen reports live enrollment status honestly rather
// than implying a mandate the backend does not check at login.
export default async function MfaPage() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>
  const tenantId = effectiveTenantId(guard.ctx)
  const users = tenantId != null ? await listLifecycleUsers(tenantId) : []
  const active = users.filter((u) => u.lifecycleState === "active")
  const enrolled = active.filter((u) => u.mfaEnabled)
  const pct = active.length ? Math.round((enrolled.length / active.length) * 100) : 0

  return (
    <div className="space-y-6">
      <SecurityHeading title="Multi-factor authentication" spec="Spec 59">
        TOTP enrollment (authenticator app + backup codes) is enforced by the backend today. What is not yet
        available is a tenant-wide policy that requires it — enrollment is currently opt-in per user.
      </SecurityHeading>

      <BackendStatus level="partial">
        Enrolling, confirming and disabling MFA are real actions backed by the database (secret + hashed backup
        codes). An admin can also force-reset a user&apos;s MFA from the user directory. A tenant-wide{" "}
        <em>require MFA</em> policy, grace periods and exemption lists are not yet enforced at login — the fields
        below show the shape that will take once that policy layer exists.
      </BackendStatus>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Active users</CardDescription>
            <CardTitle className="text-2xl">{active.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>MFA enrolled</CardDescription>
            <CardTitle className="text-2xl">{enrolled.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Enrollment rate</CardDescription>
            <CardTitle className="text-2xl">{pct}%</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Enrollment by user</CardTitle>
          </div>
          <CardDescription>Live status from the user directory. Manage per-user MFA from Admin → Users.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>MFA</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {active.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.name}</TableCell>
                    <TableCell className="text-muted-foreground">{u.email}</TableCell>
                    <TableCell className="text-muted-foreground">{u.tenantRole}</TableCell>
                    <TableCell>
                      {u.mfaEnabled ? (
                        <Badge className="border-transparent bg-emerald-600 text-white">Enrolled</Badge>
                      ) : (
                        <Badge variant="outline">Not enrolled</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Tenant MFA policy</CardTitle>
          </div>
          <CardDescription>Spec 59 — not yet enforced at login. Shown for the policy layer to come.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSpecGrid>
            <FieldSpec label="Require MFA for all users" />
            <FieldSpec label="Require MFA for admins only" />
            <FieldSpec label="Grace period before enforcement" hint="e.g. 14 days" />
            <FieldSpec label="Exempted users" />
            <FieldSpec label="Allowed methods" hint="TOTP, backup codes" />
            <FieldSpec label="Backup codes remaining per user" />
          </FieldSpecGrid>
        </CardContent>
      </Card>
    </div>
  )
}
