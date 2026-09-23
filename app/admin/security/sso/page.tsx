import { redirect } from "next/navigation"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus } from "@/components/security/backend-status"
import { SsoProvidersClient } from "@/components/security/sso-providers-client"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listProviders } from "@/lib/sso-store"
import { ssoOrigin } from "@/lib/sso-origin"

export const dynamic = "force-dynamic"

// SPECS 56–58 — Single sign-on, backed by lib/sso-store.ts, lib/sso-oidc.ts
// and app/api/auth/sso/*. OIDC is a live authorization-code flow verified
// against the IdP's real JWKS; SAML AuthnRequest and signed ACS are live.
export default async function SsoPage() {
  const session = await getSession()
  if (!session || session.role !== "admin") redirect("/dashboard")

  const tenant = getCurrentTenant()
  const providers = await listProviders(tenant?.tenantId ?? null)

  const origin = ssoOrigin()

  return (
    <div className="space-y-6">
      <SecurityHeading title="Single sign-on (SSO)" spec="Specs 56–58">
        Configure tenant identity providers. When enabled, members sign in through your identity provider instead of a
        local password. Client secrets are never displayed after creation.
      </SecurityHeading>

      <BackendStatus level="partial">
        OIDC providers (Google Workspace, Microsoft Entra ID, Okta, or any generic OIDC issuer) are a real
        authorization-code login: the callback exchanges the code and verifies the ID token against the IdP&apos;s
        live JWKS before a session is issued. SAML providers use a signed assertion-consumer flow with IdP
        certificate, issuer, audience, destination, timestamp and request-correlation checks. Configure and
        test the provider with your IdP before enabling login; single logout depends on IdP support.
      </BackendStatus>

      <SsoProvidersClient initialProviders={providers} callbackOrigin={origin} />
    </div>
  )
}
