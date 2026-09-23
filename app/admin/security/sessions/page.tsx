import { redirect } from "next/navigation"
import { LogOut } from "lucide-react"
import { SecurityHeading, FieldSpec, FieldSpecGrid } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { SessionsClient } from "@/components/security/sessions-client"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listActiveSessions } from "@/lib/session-store"

export const dynamic = "force-dynamic"

// Session management, backed by lib/session-store.ts. Every login
// (password or SSO) now writes a server-side session row keyed by the `sid`
// embedded in the signed JWT, so this screen lists real, revocable sessions
// rather than a static mock.
export default async function SessionsPage() {
  const session = await getSession()
  if (!session || session.role !== "admin") redirect("/dashboard")

  const tenant = getCurrentTenant()
  const sessions = await listActiveSessions(tenant?.tenantId ?? null, session.sid)

  return (
    <div className="space-y-6">
      <SecurityHeading title="Session management" spec="">
        See who is signed in, from where, and end sessions individually or all at once.
      </SecurityHeading>

      <BackendStatus level="live">
        Every sign-in (password or SSO) writes a server-side session row keyed by the session id embedded in the
        signed JWT cookie. Ending a session here revokes that row immediately — the next request bearing that
        cookie is treated as signed out, even though the JWT itself is still cryptographically valid until it
        expires.
      </BackendStatus>

      <SessionsClient initialSessions={sessions} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session policy</CardTitle>
          <CardDescription>enforced defaults; per-tenant tuning is not yet exposed here.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSpecGrid>
            <FieldSpec label="Session timeout" hint="7 days from sign-in (lib/auth.ts)" />
            <FieldSpec label="Concurrent session limit per user" hint="5 devices — oldest is auto-revoked" />
            <FieldSpec label="Idle timeout" hint="Not yet enforced" />
            <FieldSpec label="Remember-me duration" hint="Not yet exposed" />
            <FieldSpec label="New-device notification" hint="Not yet implemented" />
            <FieldSpec label="Force re-login on IP change" hint="Not yet implemented" />
          </FieldSpecGrid>
        </CardContent>
      </Card>
    </div>
  )
}
