/** Protocol presets only: each tenant still owns and verifies its own IdP config. */
export const SSO_OIDC_PRESETS = {
  google_workspace: {
    label: "Google Workspace",
    discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    scopes: "openid email profile",
  },
  microsoft_entra: {
    label: "Microsoft Entra ID",
    discoveryUrl: "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
    scopes: "openid profile email",
  },
  okta: {
    label: "Okta",
    discoveryUrl: "", // Tenant-specific: https://<your-domain>/oauth2/default/.well-known/openid-configuration
    scopes: "openid profile email",
  },
  generic_oidc: { label: "Generic OIDC", discoveryUrl: "", scopes: "openid email profile" },
} as const

export function sameTenant(providerTenantId: number | null, userTenantId: number | null) {
  return providerTenantId === null || providerTenantId === userTenantId
}
