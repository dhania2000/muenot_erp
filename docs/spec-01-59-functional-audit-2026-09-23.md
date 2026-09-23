# Functional audit of requested specs (2026-09-23)

This is a conservative implementation audit, not a certification. A route,
table, or UI page alone is not proof of a complete specification. The existing
`spec-01-49-ui-audit.md` primarily maps UI routes. This pass inspected the
current codebase and completed the bounded, tested security work listed below;
it did not finish all 23 end-to-end specifications.

Status values are **COMPLETE**, **PARTIAL**, **PENDING**, and **NOT APPLICABLE**.
The columns are frontend (F), backend (B), database (D), API (A), security (S),
and tests (T). **PARTIAL** also means the component has not yet been proven
end-to-end under production infrastructure. Previous statuses are from the
request, not reasserted as fact.

| Spec | Previous | F | B | D | A | S | T | Final | Existing evidence / remaining limitation |
|---|---|---|---|---|---|---|---|---|---|
| 1 Multi-tenant SaaS | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/tenant-context.ts`, `lib/tenant-service.ts`, `/platform/tenants`; tenant enforcement defaults to report mode; full protected-route inventory and deployment-mode proof remain. |
| 2 Tenant isolation | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/tenant-guard.ts`, `lib/tenant-tables.ts`, tenant-scope tests exist; cross-module IDOR, export, file, background-job and cache proof remains. |
| 4 Platform console | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `/platform/*` and platform-role guards exist; real metrics, all privileged actions and audit coverage were not verified end-to-end. |
| 9 ABAC | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/abac-*.ts`, `/admin/security/access-policies` exist; this change makes tenant-scoped evaluation failures deny access. Complete attribute/policy and route-by-route enforcement proof remains. |
| 14 User lifecycle | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/user-lifecycle.ts`, `/admin/users` support many flows; offboarding transfers/session/API-key revocation and full User 360 coverage are not proven. MFA secret handling was hardened in this change. |
| 19 Usage metering | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/billing/usage-metering.ts`, billing/platform usage pages exist; all requested event sources, cycle aggregation, reconciliation and duplicate prevention need integration proof. |
| 21 Payment gateways | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | Billing gateway services, routes and tests exist; live provider configuration, webhook/failure and adapter independence are not certified. |
| 26 Customer storage | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/storage/providers.ts`, S3-compatible adapter, connections UI/API exist; each named provider and tenant cross-access needs live integration testing. |
| 29 Presigned access | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/storage/signing.ts`, file routes and detail UI exist; negative IDOR, expiry and private-delivery tests across providers remain. |
| 30 Large uploads | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/storage/multipart-store.ts`, upload APIs and UI exist; network-resume/finalization and abandoned-upload cleanup proof remains. |
| 31 CDN/media | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/storage/cdn.ts` exists; configurable secure delivery and multi-provider health/private-content proof remains. |
| 32 File metadata | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/storage/file-metadata.ts`, file browser/detail UI exist; every module's migration into central metadata and tenant-scoped query proof remains. |
| 34 Malware scanning | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/storage/file-scanning.ts`, security UI/API exist; real scanner integration, safe-download gating and quarantine/failure tests remain. |
| 39 Tenant configuration | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/tenant-settings.ts`, `/admin/settings` exist; full inheritance/override coverage and audited reset-to-default behavior are not proven. |
| 44 Job idempotency | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/job-idempotency.ts` and tests exist; all requested billing/payroll/payment/notification jobs and concurrent duplicate behavior remain to audit. |
| 47 Workflow builder | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/workflows/*`, `/admin/workflows` and tests exist; complete branch/action catalog, publish validation and simulation require end-to-end proof. |
| 50 Email engine | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/email-engine/*`, `/admin/automation/email` and tests exist; all HR/CRM/Finance integrations, bounce and legal tracking requirements remain. |
| 51 API platform | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/api-platform/*`, `/api/v1/*`, API/webhook UI exist; wrapper is not universally applied to old APIs; safe request logs and full compatibility tests remain. |
| 53 API rate limiting | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | This change adds shared MySQL atomic counters, per-plan/key/endpoint/tenant policies, temporary abuse blocks and working policy CRUD for `/api/v1/*`. User-specific and other API surfaces, blocked-request analytics, live multi-worker DB test and migration execution remain. |
| 55 Webhook security | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/webhooks-store.ts`, dispatcher, tests and UI exist; secret rotation/replay/TLS/delivery-history security must be verified against the complete spec. |
| 56 SSO foundation | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | `lib/sso-store.ts`, OIDC/SAML routes and UI exist. This change fixes canonical origin and SAML callback state. Provider lifecycle, account deprovisioning and external IdP tests remain. |
| 58 SAML | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | Earlier audit was stale: `lib/sso-saml.ts` already uses `@node-saml/node-saml` with ACS, metadata and request validation. This change hardens cross-site state cookie, provider binding and request-ID replay. IdP metadata import, supported logout, live IdP and XML attack tests remain. |
| 59 MFA | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL | This change encrypts new TOTP secrets, upgrades legacy secrets when the master key is present, atomically rejects TOTP replay, and counts invalid MFA codes toward lockout. `/admin/security/mfa` still has a simulated policy save; mandatory enrollment, recovery governance and trusted devices remain. |

## Changed in this pass

- SPEC 9: `lib/abac-enforce.ts` and `test/abac-fail-closed.test.ts`.
- SPEC 53: `lib/api-platform/rate-limit-store.ts`, `rate-limit-policies.ts`,
  `handler.ts`, rate-limit admin routes/UI, cleanup cron/scheduler, tenant table
  registry, `database/migrations/2026-09-23-api-rate-limit-counters.sql`, and
  `test/api-shared-rate-limit.test.ts` / `test/api-rate-policy-routes.test.ts`.
- SPECS 56/58: `lib/sso-origin.ts`, `sso-state.ts`, `sso-saml.ts`, SSO login,
  callback, ACS and metadata routes, SSO admin page, and
  `test/sso-security-hardening.test.ts`.
- SPEC 59: `lib/mfa.ts`, `lib/user-lifecycle.ts`, `app/api/auth/login/route.ts`,
  `database/migrations/2026-09-23-mfa-secret-hardening.sql`, and
  `test/mfa-replay-hardening.test.ts` / `test/mfa-challenge-storage.test.ts` /
  `test/mfa-login-lockout.test.ts`.
- Corrected an existing nondeterministic tamper test in
  `test/secret-management.test.ts`.

## Operational limits

The full unit suite and production build pass, but this pass did not run SQL
migrations against a staging/production MySQL database, connect to a real IdP,
or exercise live payment/storage/webhook providers. The new rate-limiter
requires its migration (or runtime table-create permission). SSO requires a
canonical HTTPS `APP_URL` and a strong `SESSION_SECRET`; MFA encryption
requires `SETTINGS_ENCRYPTION_KEY`. Existing credentials must never be placed
in this document or committed to Git.
