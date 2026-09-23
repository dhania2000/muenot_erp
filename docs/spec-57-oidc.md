# OIDC

The existing tenant provider store and OIDC flow are reused. A provider can use discovery or explicit endpoints; Google Workspace, Microsoft Entra ID, Okta and generic OIDC are configured per tenant.

The authorization-code flow now uses RFC 7636 PKCE with S256 for every provider. The verifier lives only inside the signed, HttpOnly, five-minute state cookie and is consumed once at callback. The callback validates state, provider identity, nonce, issuer, audience, signature, expiry and subject before tenant-scoped account linking/provisioning and server-side session creation.

Local logout already revokes the opaque server-side session and clears the cookie. IdP-wide logout is deliberately provider-specific and not inferred from an unknown issuer's endpoints.
