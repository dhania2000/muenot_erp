import { Lock, ShieldCheck } from "lucide-react"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { AccessPolicyBuilder } from "@/components/security/access-policy-builder"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

const TENANT_ROLES: { role: string; description: string }[] = [
  { role: "tenant_owner", description: "Ultimate owner of the tenant — billing, plan, and tenant deletion." },
  { role: "tenant_admin", description: "Full administrative access within the tenant." },
  { role: "module_admin", description: "Elevated access, scoped to specific modules by the permission matrix." },
  { role: "employee", description: "Standard access, scoped by the permission matrix." },
]

const PLATFORM_ROLES: { role: string; description: string }[] = [
  { role: "platform_super_admin", description: "Full platform control, including managing platform staff." },
  { role: "platform_staff", description: "Muenot staff — manage tenants, plans, and support." },
  { role: "none", description: "Not a platform operator." },
]

// SPEC 63 — Access policies. A fixed, enforced role model already exists
// (lib/role-model.ts + lib/platform-guard.ts) and is checked on every
// tenant-admin route. On top of that, tenant admins can now define CUSTOM,
// condition-based policies in the builder below: those are persisted
// (lib/access-policy-store.ts) and enforced at sign-in (app/api/auth/login),
// where a matching Deny blocks the sign-in and a "Require MFA" obligation
// forces the MFA challenge.
export default function AccessPoliciesPage() {
  return (
    <div className="space-y-6">
      <SecurityHeading title="Access policies" spec="Spec 63">
        Roles that control what a user can see and do, plus custom conditional policies. The platform and tenant
        role axes are enforced on every admin request; conditional policies are evaluated at sign-in.
      </SecurityHeading>

      <BackendStatus level="live">
        The four tenant roles and three platform roles below are real and enforced on every request via
        lib/platform-guard.ts. The conditional policies you build below are persisted per tenant and enforced by
        the login flow — a matching Deny blocks sign-in, and a Require MFA / re-authentication obligation is
        applied before a session is issued.
      </BackendStatus>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">Tenant roles</CardTitle>
            </div>
            <CardDescription>Enforced today, ranked highest to lowest authority.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {TENANT_ROLES.map((r) => (
              <div key={r.role} className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">{r.description}</p>
                </div>
                <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
                  {r.role}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Lock className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">Platform roles</CardTitle>
            </div>
            <CardDescription>
              Orthogonal to tenant roles — never implicitly grants access to a tenant&apos;s data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {PLATFORM_ROLES.map((r) => (
              <div key={r.role} className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">{r.description}</p>
                </div>
                <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
                  {r.role}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <AccessPolicyBuilder />
    </div>
  )
}
