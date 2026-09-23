# SSO Foundation

## Audit and reuse

The repository already provides encrypted SSO provider storage, an OIDC authorization-code flow with signed `state`/`nonce`, live JWKS ID-token verification, server-side sessions, tenant roles, an SSO administration UI, and login-event auditing. This implementation extends those components rather than creating another authentication system.

## Supported OIDC integrations

Provider presets document the standard discovery endpoints for Google Workspace and Microsoft Entra ID. Okta and generic OIDC are supported through each tenant's issuer discovery URL. The existing OIDC flow uses the configured client ID/secret, authorization-code exchange and live JWKS validation.

## Tenant isolation and account lifecycle

- `sso_identities` binds an immutable IdP `sub` claim to one local user and tenant.
- Email matching is now tenant-scoped. A provider cannot link to a matching address owned by another tenant.
- Tenant administrators can deprovision a linked SSO identity through the scoped API. It marks the identity deprovisioned, inactivates the local user and revokes all their server-side sessions.

## SAML 2.0 boundary

SAML metadata (entity ID, SSO URL, certificate, mapped attributes) is supported in the provider store and administration UI. A production SAML assertion consumer must use a maintained, independently audited XML-signature library and be tested against the customer IdP; the current repository has no such dependency. The configuration remains disabled for login until that verified assertion consumer is supplied—this is intentional to avoid accepting an unsigned or XML-wrapped assertion.

## API paths

- `/api/auth/sso/:providerId/login` and `/callback` — OIDC authorization-code login.
- `/api/admin/security/sso` — tenant-admin provider management.
- `/api/admin/security/sso/:id/identities/:identityId` `DELETE` — tenant-admin deprovisioning and session revocation.
