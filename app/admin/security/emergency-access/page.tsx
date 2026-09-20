import { AlertTriangle, ShieldAlert } from "lucide-react"
import { SecurityHeading, EmptyState, FieldSpec, FieldSpecGrid } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export const dynamic = "force-dynamic"

// SPEC 65 — Emergency ("break-glass") access. There is no elevated,
// time-boxed, auto-revoking access path that bypasses normal role checks —
// every request still goes through the standard tenant-admin guard. This
// screen shows the structure a break-glass workflow would need.
export default function EmergencyAccessPage() {
  return (
    <div className="space-y-6">
      <SecurityHeading title="Emergency access" spec="Spec 65">
        Break-glass access for incidents: request temporary elevated permissions with mandatory justification,
        automatic time-boxed expiry, and a full audit trail.
      </SecurityHeading>

      <BackendStatus level="planned">
        There is no break-glass path today — every request goes through the standard role guard in
        lib/platform-guard.ts, with no bypass, approval flow, or auto-revoke timer. Requesting emergency access
        below is disabled until that workflow exists.
      </BackendStatus>

      <div className="flex justify-end">
        <Button disabled className="gap-1.5">
          <ShieldAlert className="size-4" /> Request emergency access
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Emergency access history</CardTitle>
          </div>
          <CardDescription>requested by · reason · scope · approved by · granted · expired · actions taken</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested by</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expired</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell colSpan={5} className="p-0">
                    <EmptyState icon={<ShieldAlert className="size-5" />} title="No emergency access has ever been requested">
                      Once this workflow is backed, every break-glass grant and the actions taken during it will
                      be listed here for audit.
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
          <CardTitle className="text-base">Request fields</CardTitle>
          <CardDescription>Spec 65 — captured on each break-glass request once the backend exists.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSpecGrid>
            <FieldSpec label="Requested by" />
            <FieldSpec label="Justification" hint="Required, free text" />
            <FieldSpec label="Requested scope / role" />
            <FieldSpec label="Duration" hint="e.g. 1 hour, auto-revoked" />
            <FieldSpec label="Approver" hint="A second admin must approve" />
            <FieldSpec label="Notify security team" />
            <FieldSpec label="Actions log during grant" />
          </FieldSpecGrid>
        </CardContent>
      </Card>
    </div>
  )
}
