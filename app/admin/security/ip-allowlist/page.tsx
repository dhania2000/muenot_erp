import { Globe, Plus } from "lucide-react"
import { SecurityHeading, EmptyState, FieldSpec, FieldSpecGrid } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export const dynamic = "force-dynamic"

// SPEC 62 — IP allowlisting. No middleware or route guard checks the request's
// source IP against a stored list today, so nothing here can be enabled.
export default function IpAllowlistPage() {
  return (
    <div className="space-y-6">
      <SecurityHeading title="IP allowlist" spec="Spec 62">
        Restrict sign-in to specific IP ranges. When enabled, requests outside the allowlist are blocked before
        they reach the application.
      </SecurityHeading>

      <BackendStatus level="planned">
        No request-path check exists yet for source IP against a stored allowlist — every request is currently
        accepted regardless of origin. This screen shows the entries, fields and enforcement toggle the tenant
        will manage once that check is wired into the request pipeline.
      </BackendStatus>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Enforcement is off. Adding an entry has no effect yet.</p>
        <Button disabled className="gap-1.5">
          <Plus className="size-4" /> Add IP range
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Allowed ranges</CardTitle>
          </div>
          <CardDescription>label · CIDR range · environment · created by · last matched</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>CIDR range</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Last matched</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell colSpan={5} className="p-0">
                    <EmptyState icon={<Globe className="size-5" />} title="No IP ranges configured">
                      Once the enforcement check exists, entries added here will restrict which networks can sign
                      in to this tenant.
                    </EmptyState>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Entry fields</CardTitle>
          <CardDescription>Spec 62 — captured per range once the backend exists.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSpecGrid>
            <FieldSpec label="Label" />
            <FieldSpec label="CIDR range" hint="e.g. 203.0.113.0/24" />
            <FieldSpec label="Mode" hint="Allow or block" />
            <FieldSpec label="Applies to" hint="All sign-ins or admin console only" />
            <FieldSpec label="Created by" />
            <FieldSpec label="Last matched" />
          </FieldSpecGrid>
        </CardContent>
      </Card>
    </div>
  )
}
