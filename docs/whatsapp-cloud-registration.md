# WhatsApp post-onboarding Cloud API registration

## 1. Root cause and audit

The existing launcher already used Facebook Login for Business, captured the WA_EMBEDDED_SIGNUP FINISH IDs and posted the authorization code and server-issued state. The callback verified tenant/user ownership, exchanged the code, verified the phone profile, stored an encrypted tenant integration, subscribed the webhook and synchronized templates.

There was **no phone /register call**. Comments incorrectly assumed Embedded Signup registered the Cloud API phone. Health checks also retried *every* phone-profile error without status/platform fields, losing the registration signal. The UI then offered another signup instead of finalizing the saved connection.

The existing Embedded Signup launcher, code exchange, integration upsert, webhook ingestion and template service remain in place. This change does not create a new tenant or replace Mubarik Bangles Manufacturer's connection.

## 2. Files and responsibilities

- lib/whatsapp-registration.ts: tenant-owned registration, Meta verification, encrypted PIN, metadata sync, sanitized logging and database advisory locks.
- lib/whatsapp-signup.ts: durable exchange progress, completed-callback replay, exact-phone readback, subscription check and registration integration.
- lib/whatsapp.ts: narrow profile fallback, phone ownership conflict checks and fail-closed ambiguous webhook lookup.
- lib/whatsapp-health.ts: authoritative registration check and tenant-filtered webhook statistics.
- app/api/marketing/whatsapp/registration/route.ts: administrator retry endpoint.
- app/api/marketing/whatsapp/signup/callback/route.ts: registration result and safe exception handling.
- app/api/marketing/whatsapp/webhook/route.ts: WABA consistency check.
- components/marketing/marketing-whatsapp-client.tsx and components/marketing/whatsapp/{settings-tab,connection-badge,embedded-signup-connect,types}: retained workspace access, retry/PIN input and truthful readiness.
- lib/tenant-tables.ts: register the two new tenant-owned tables with the guard.
- test/whatsapp-{registration,signup-finalization,registration-api,health-isolation,webhook-tenant}.test.ts: mocked integration regressions.

## 3. Migration

Apply database/migrations/2026-09-21-whatsapp-cloud-registration.sql. It creates:

1. marketing_whatsapp_registration: tenant/connection identity, encrypted PIN, cloud_api_registered, registration_status, registration_error_code, registration_error_message and registration_checked_at.
2. marketing_whatsapp_signup_progress: tenant/signup identity, exchange status, encrypted resumable token and connection ID.

DDL is additive and idempotent; the lazy initializer can create these tables if the deployment account has permission. No existing connection, token, WABA or phone is deleted or reassigned. Back up the database before deployment using your normal process.

## 4. Registration flow and idempotency

Finalization uses the existing tenant connection's token and Phone Number ID. It verifies the phone is listed under that connection's WABA and is not assigned to another tenant. It reads Meta status/platform before registering. Already CONNECTED Cloud API numbers skip POST registration. ON_PREMISE numbers require a deliberate migration.

For an eligible unregistered number the backend sends POST /{configured-graph-version}/{phone-number-id}/register with messaging_product=whatsapp and a six-digit PIN. It then reads Meta again; POST acceptance alone never sets messaging ready. Missing/unsupported status remains unconfirmed/failed, not a fabricated success. A successful verification also refreshes stored phone metadata.

New PINs are random per connection and encrypted with SETTINGS_ENCRYPTION_KEY before use. Existing two-step verification requires the number's existing PIN; admins may provide it through a password field. Stored PINs/tokens are never returned to the browser. Missing encryption or unreadable secrets fail closed; no universal PIN is used.

Database advisory locks serialize signup, phone ownership assignment and connection registration across processes. Lock connections are separate from the application query pool to avoid pool starvation; they are released in finally/on disconnect. A concurrent invocation returns a retryable conflict.

Authorization exchange progress is persisted before/after exchange, with encrypted temporary token storage. Completed callback replay returns the same connection without another exchange/upsert/subscription. An interrupted *unconfirmed* code exchange cannot be retried blindly: Meta may have consumed the code. Check for an existing connection first; reauthorization is necessary only if no recoverable token remains. This is not a claim of distributed exactly-once execution across Meta and MySQL.

## 5. Existing connection retry

After deployment open WhatsApp → Settings → Retry registration. No second Embedded Signup is required for a usable saved token. Supply the existing six-digit PIN only when already configured; otherwise leave blank for a connection-specific generated PIN.

POST /api/marketing/whatsapp/registration accepts connectionId and optional pin. The server derives tenant authority from the stored-role guard, loads only that tenant's connection and ignores client token/WABA/phone/tenant fields. Origin and input checks apply. The UI refreshes health and phone metadata afterward.

## 6. Tenant isolation

No client runtime identity is taken from WHATSAPP_WABA_ID or WHATSAPP_PHONE_NUMBER_ID. New attempts to assign one phone to two tenants are rejected under a phone lock. Existing ambiguous duplicate phone mappings are not migrated/deleted; registration and webhook resolution fail closed until an administrator resolves ownership.

Signed webhook ingestion resolves the phone's unique tenant, verifies the WABA matches and then enters tenant processing. Unknown/mismatched/ambiguous mappings are skipped. Application webhook statistics now include WHERE tenant_id = ?. The tenant guard is not weakened.

## 7. Logging and failures

Structured registration logs include tenant/connection/WABA/phone IDs, configured Graph version, operation, phase, timestamp, HTTP status, numeric Meta code/subcode and an allowlisted explanation. Raw response messages, request bodies, tokens, authorization codes, app secrets and PINs are not logged.

The UI receives normalized states and safe explanations. A timeout is uncertain, not successful; an explicit retry probes Meta before another POST. Missing/expired credentials require repair/reauthorization, not replacing IDs with global values. Business-verification pending is surfaced when explicitly reported by Meta; this code does not bypass verification.

## 8. Tests and deployment checks

Mocked tests cover new/already-registered phones, pending acceptance, failed PIN, retry, encryption, expired token, missing phone, wrong tenant, two independent tenants, credential isolation, duplicate finalization/callback, resumable exchange, uncertain exchange, timeout, refreshed status, webhook tenant/WABA routing, tenant-filtered statistics and administrator/origin boundaries.

No automated test registers a real phone or sends a real message. Production MySQL advisory locks, real Meta permissions/status behavior, UI interaction and live registration still require deployment verification. Existing TypeScript build-ignore configuration remains unchanged; a successful build is not a clean full-repository type-check.

## 9. Environment

Existing DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME and SETTINGS_ENCRYPTION_KEY are required. Do not rotate/remove the encryption key casually: previously stored tokens and PINs depend on it. The app's DB account must support named locks and the additive schema (or have an administrator apply the migration).

Keep existing WHATSAPP_APP_ID, WHATSAPP_CONFIG_ID, WHATSAPP_APP_SECRET, webhook configuration and APP_URL. WHATSAPP_GRAPH_VERSION selects the project's Graph version (default v26.0). No global phone, WABA or registration PIN variable is required.

## 10. Meta-side actions that may remain

- If two-step verification already exists, supply its PIN or follow Meta's reset process; do not repeatedly guess PINs.
- Complete pending business/number verification, permissions, account eligibility or on-premise migration in Meta when required.
- If Meta reports an expired/revoked token, reauthorize that connection.
- Meta documents a registration window after Embedded Signup; if Meta rejects registration because that window expired, new signup may be required. The ERP does not force new signup merely because registration is pending.

Primary references: [Meta's registration request](https://www.postman.com/meta/whatsapp-business-platform/request/77hl2kg/register-phone), [Meta Cloud API registration documentation](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-93b72c24-1e05-4eef-9aec-c43a9d8eecef).
