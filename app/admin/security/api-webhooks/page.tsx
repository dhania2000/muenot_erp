import { redirect } from "next/navigation"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { ApiWebhooksClient } from "@/components/security/api-webhooks-client"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { AVAILABLE_SCOPES, API_KEY_ENVIRONMENTS, listApiKeys } from "@/lib/api-keys-store"
import { WEBHOOK_EVENTS, listEndpoints } from "@/lib/webhooks-store"

export const dynamic = "force-dynamic"

// SPECS 67-70 — API key platform + webhook delivery engine. Keys authenticate
// the public /api/v1/* surface (lib/api-auth.ts); webhook endpoints receive
// signed, retried deliveries fanned out by lib/webhooks/dispatcher.ts.
export default async function ApiWebhooksPage() {
  const session = await getSession()
  if (!session || session.role !== "admin") redirect("/dashboard")

  const tenant = getCurrentTenant()
  const tenantId = tenant?.tenantId ?? 0

  const [keys, endpoints] = await Promise.all([listApiKeys(tenantId), listEndpoints(tenantId)])

  return (
    <div className="space-y-6">
      <SecurityHeading title="API & webhooks" spec="Specs 67-70">
        Issue scoped API keys for server-to-server integrations, and subscribe webhook endpoints to receive signed,
        automatically retried event notifications.
      </SecurityHeading>

      <BackendStatus level="full">
        API keys authenticate real requests to <code className="rounded bg-muted px-1">/api/v1/clients</code> — only
        a SHA-256 hash of each key is stored, and access is enforced per-scope on every request. Webhook deliveries
        are signed with an HMAC-SHA256 <code className="rounded bg-muted px-1">X-Webhook-Signature</code>, sent live
        over HTTP, and automatically retried with exponential backoff on failure (also available on-demand from the
        delivery log below).
      </BackendStatus>

      <ApiWebhooksClient
        initialKeys={keys}
        scopeOptions={AVAILABLE_SCOPES}
        envOptions={API_KEY_ENVIRONMENTS}
        initialEndpoints={endpoints}
        eventOptions={WEBHOOK_EVENTS}
      />
    </div>
  )
}
