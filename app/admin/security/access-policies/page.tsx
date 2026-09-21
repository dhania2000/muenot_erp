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
// tenant-admin route. What is NOT yet possible is defining CUSTOM policies —
// per-field, per-record, or condition-based rules beyond the four fixed
// tenant roles shown below.
export default function AccessPoliciesPage() {
  return (
    <div className="space-y-6">
      <SecurityHeading title="Access policies" spec="Spec 63">
        Roles that control what a user can see and do. The platform and tenant role axes are enforced on every
        admin request; custom, condition-based policies are not yet available.
      </SecurityHeading>

      <BackendStatus level="partial">
        The four tenant roles and three platform roles below are real and enforced on every request via
        lib/platform-guard.ts — this is not a mock. What&apos;s missing is a policy BUILDER: custom rules scoped to
        a field, record condition, time window, or resource beyond these fixed roles.
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
