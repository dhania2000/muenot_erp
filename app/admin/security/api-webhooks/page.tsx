import { redirect } from "next/navigation"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { ApiWebhooksClient } from "@/components/security/api-webhooks-client"
import { OAuthAppsClient } from "@/components/security/oauth-apps-client"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { AVAILABLE_SCOPES, API_KEY_ENVIRONMENTS, listApiKeys } from "@/lib/api-keys-store"
import { WEBHOOK_EVENTS, listEndpoints } from "@/lib/webhooks-store"
import {
  OAUTH_SCOPES,
  DEFAULT_TOKEN_TTL_SECONDS,
  MIN_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  DEFAULT_ROTATION_GRACE_SECONDS,
  MAX_ROTATION_GRACE_SECONDS,
  listOAuthApps,
} from "@/lib/oauth/oauth-apps-store"

export const dynamic = "force-dynamic"

// SPECS 67-70 — API key platform + webhook delivery engine. Keys authenticate
// the public /api/v1/* surface (lib/api-auth.ts); webhook endpoints receive
// signed, retried deliveries fanned out by lib/webhooks/dispatcher.ts.
export default async function ApiWebhooksPage() {
  const session = await getSession()
  if (!session || session.role !== "admin") redirect("/dashboard")

  const tenant = getCurrentTenant()
  const tenantId = tenant?.tenantId ?? 0

  const [keys, endpoints, oauthApps] = await Promise.all([
    listApiKeys(tenantId),
    listEndpoints(tenantId),
    listOAuthApps(tenantId),
  ])

  return (
    <div className="space-y-6">
      <SecurityHeading title="Developer center" spec="Specs 67-70 · 32-33">
        Everything integrators need in one place: register OAuth apps for the client-credentials grant, issue scoped
        API keys for server-to-server calls, and subscribe webhook endpoints to receive signed, automatically retried
        event notifications. The full API contract is published as OpenAPI at{" "}
        <a className="font-medium underline underline-offset-2" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
          /api/v1/openapi.json
        </a>
        .
      </SecurityHeading>

      <BackendStatus level="live">
        OAuth apps mint least-privilege, revocable access tokens from{" "}
        <code className="rounded bg-muted px-1">/api/v1/oauth/token</code> — client secrets are stored only as SHA-256
        hashes and support rotation with a grace window. API keys authenticate real requests to{" "}
        <code className="rounded bg-muted px-1">/api/v1/clients</code>, enforced per-scope on every request. Webhook
        deliveries are signed with an HMAC-SHA256{" "}
        <code className="rounded bg-muted px-1">X-Webhook-Signature</code>, sent live over HTTP, and automatically
        retried with exponential backoff on failure (also available on-demand from the delivery log below).
      </BackendStatus>

      <OAuthAppsClient
        initialApps={oauthApps}
        scopeOptions={OAUTH_SCOPES}
        tokenTtl={{
          default: DEFAULT_TOKEN_TTL_SECONDS,
          min: MIN_TOKEN_TTL_SECONDS,
          max: MAX_TOKEN_TTL_SECONDS,
        }}
        rotationGrace={{ default: DEFAULT_ROTATION_GRACE_SECONDS, max: MAX_ROTATION_GRACE_SECONDS }}
      />

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
