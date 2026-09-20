import { Monitor, LogOut } from "lucide-react"
import { SecurityHeading, EmptyState, FieldSpec, FieldSpecGrid } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export const dynamic = "force-dynamic"

// SPEC 61 — Session management. lib/auth.ts issues a stateless, signed JWT
// cookie (7-day expiry) with no server-side session record, so there is
// nothing today to list, filter by device/location, or revoke individually or
// in bulk. This screen shows the structure that a session store would need to
// back before any of those actions can be real.
export default function SessionsPage() {
  return (
    <div className="space-y-6">
      <SecurityHeading title="Session management" spec="Spec 61">
        See who is signed in, from where, and end sessions individually or all at once.
      </SecurityHeading>

      <BackendStatus level="planned">
        Sign-in issues a stateless JWT cookie with a fixed 7-day expiry (lib/auth.ts) — there is no server-side
        session record to list or revoke. Nothing on this screen can act until a session store exists; the table
        and controls below show the shape that store will back.
      </BackendStatus>

      <div className="flex justify-end">
        <Button variant="destructive" size="sm" disabled className="gap-1.5">
          <LogOut className="size-4" /> Sign out all sessions
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Monitor className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Active sessions</CardTitle>
          </div>
          <CardDescription>user · device · browser · IP · location · signed in · last active</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>IP address</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell colSpan={6} className="p-0">
                    <EmptyState icon={<Monitor className="size-5" />} title="No session store connected">
                      Once sessions are persisted server-side, each row here will let you end that single session.
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
          <CardTitle className="text-base">Session policy</CardTitle>
          <CardDescription>Spec 61 — not yet enforced.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSpecGrid>
            <FieldSpec label="Session timeout" hint="Currently fixed at 7 days" />
            <FieldSpec label="Idle timeout" />
            <FieldSpec label="Concurrent session limit per user" />
            <FieldSpec label="Remember-me duration" />
            <FieldSpec label="New-device notification" />
            <FieldSpec label="Force re-login on IP change" />
          </FieldSpecGrid>
        </CardContent>
      </Card>
    </div>
  )
}
