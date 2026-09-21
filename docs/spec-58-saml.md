# SPEC 58 — SAML 2.0

SAML providers use the existing tenant-scoped Entity ID, SSO URL, X.509 certificate and attribute-mapping fields. The new ACS uses `@node-saml/node-saml` to enforce signed response/assertion validation, IdP issuer, SP audience, assertion timestamps and durable `InResponseTo` correlation. Metadata is available per provider at `/api/auth/sso/:providerId/saml/metadata`.

The ACS maps only configured IdP attributes, applies the provider's tenant/domain mapping, then uses the same immutable subject linking and server-side session lifecycle as OIDC. A tenant administrator can deprovision any linked identity through the existing scoped SSO identity endpoint.
