import { Users } from "lucide-react"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { listLifecycleUsers } from "@/lib/user-lifecycle"
import { SecurityHeading, EmptyState } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { AccessReviewCampaigns } from "@/components/security/access-review-campaigns"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

// SPEC 66 — Access reviews. The current access snapshot below (who has which
// role) is real, live data from the user directory — useful for a manual
// review today. What's missing is the CAMPAIGN workflow: assigning reviewers,
// due dates, certify/revoke decisions, and tracking overdue reviews.
export default async function AccessReviewsPage() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return <p className="p-6">Tenant administrator access is required.</p>
  const tenantId = effectiveTenantId(guard.ctx)
  const users = tenantId != null ? await listLifecycleUsers(tenantId) : []
  const active = users.filter((u) => u.lifecycleState === "active")
  const elevated = active.filter((u) => u.tenantRole !== "employee")

  return (
    <div className="space-y-6">
      <SecurityHeading title="Access reviews" spec="Spec 66">
        Periodically re-certify who has elevated access, so grants don&apos;t silently outlive their justification.
      </SecurityHeading>

      <BackendStatus level="partial">
        The access snapshot below — every user with elevated (non-employee) access today — is real, live data
        pulled from the user directory. What&apos;s not yet built is a review CAMPAIGN: assigning a reviewer, a
        due date, recording a certify/revoke decision per user, and flagging overdue reviews.
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
            <CardDescription>With elevated access</CardDescription>
            <CardTitle className="text-2xl">{elevated.length}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Current elevated access</CardTitle>
          </div>
          <CardDescription>Live snapshot — not yet tied to a review campaign or decision trail.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Review decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {elevated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="p-0">
                      <EmptyState icon={<Users className="size-5" />} title="No users with elevated access">
                        Every active user currently holds the base employee role.
                      </EmptyState>
                    </TableCell>
                  </TableRow>
                ) : (
                  elevated.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.name}</TableCell>
                      <TableCell className="text-muted-foreground">{u.email}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-[11px]">
                          {u.tenantRole}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">Add to a campaign below</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <AccessReviewCampaigns
        candidates={elevated.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.tenantRole }))}
      />
    </div>
  )
}
