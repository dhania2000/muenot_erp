# Muenot Shopkeeper Mobile Platform — Phase 1

## What exists today

Muenot ERP is a Next.js/MySQL SaaS backend. It already has signed browser sessions, server-side session revocation, password/MFA lifecycle controls, platform and tenant role axes, permission matrices, tenant-context isolation, plan/feature entitlement guards, subscriptions/billing, tenant settings, audit/notification services, storage abstractions, and an isolated multi-tenant WhatsApp Cloud API stack.

WhatsApp already covers Embedded Signup, encrypted per-tenant tokens, WABA/phone ownership, webhook resolution, contacts, conversations, messages, templates, campaigns, automations, shared inbox roles, health checks and Cloud API registration. The mobile routes reuse these services; no second Meta connection, WABA, token store or webhook was created.

Products exist, but their current records are not tenant-scoped. Existing ERP order models are also not a Shopkeeper order service. They are deliberately returned as `501 future_module` to avoid leaking a global ERP record set.

## Tenant and profile model

`tenants.tenant_type` now supports `ENTERPRISE`, `SME`, and `SHOPKEEPER`. Existing rows default to `ENTERPRISE`, so nothing is reassigned. `shopkeeper_profiles` is a one-to-one, tenant-scoped business profile with shop name, owner, category, email/phone, address, city/state/PIN/country, logo, hours, timezone/currency, GSTIN and website. It does not replace legacy company settings.

## Native authentication

Base URL: `https://<your-host>/api/mobile/v1`

The machine-readable contract is [openapi-mobile-v1.yaml](./openapi-mobile-v1.yaml).

`POST /auth/login` accepts `email`, `password`, optional `deviceName` and `platform`. It uses the existing password hash, lockout, account lifecycle and active-tenant checks. It returns a 15-minute signed bearer access token and an opaque 30-day refresh token. Refresh tokens are SHA-256 hashed at rest; access tokens are not browser cookies.

Send every protected request with `Authorization: Bearer <accessToken>`. `POST /auth/refresh` rotates refresh tokens. `POST /auth/logout` revokes the current server-side mobile session. `GET /auth/sessions` and `DELETE /auth/sessions` provide device/session management. MFA-enabled accounts are not bypassed; native MFA completion is explicitly pending before such users can sign in.

Every protected call checks the persisted mobile session, user active status and tenant active status. Tenant identity comes only from the verified bearer session—never a client-supplied `tenant_id`.

## Implemented endpoints

| Endpoint | Phase 1 behavior |
| --- | --- |
| `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/sessions` | Native token lifecycle and device sessions |
| `/me`, `/tenant`, `/settings`, `/dashboard` | User, tenant/profile, entitlements and existing personal dashboard |
| `/whatsapp`, `/conversations`, `/conversations/{id}`, `/messages` | Existing connection health, inbox, history and server-side message send |
| `/contacts`, `/templates`, `/campaigns`, `/automations` | Tenant-scoped existing WhatsApp services |
| `/team`, `/notifications`, `/subscription`, `/devices` | Tenant users, in-app notifications, subscription/entitlement snapshot and FCM-ready device registration |
| `/products`, `/orders` | Explicit `501 future_module`; not safely tenant-backed yet |

List responses use bounded `limit` pagination where applicable. Errors are JSON with `error` and, when helpful, a stable `code`; no database or Meta credential details are returned.

## Authorization and plans

The `shopkeeper` entitlement preset introduces explicit flags such as `shopkeeper.mobile_app`, `shopkeeper.whatsapp`, `shopkeeper.inbox`, `shopkeeper.contacts`, templates, campaigns, automations, team, subscription and settings. Every mobile data route checks its server-side plan flag. WhatsApp routes also reuse existing per-agent capabilities, conversation assignment checks and tenant-scoped service queries. UI hiding is not an authorization mechanism.

Plans remain configurable through the existing plan entitlement JSON: enable only the required `shopkeeper.*` flags. Shopkeeper does not automatically inherit HR, Recruitment, or other enterprise ERP capabilities.

## Realtime design

The existing path remains `Meta webhook → resolved tenant/integration → persisted WhatsApp message → notification service`. `mobile_device_registrations` stores an encrypted device registration token plus hash, user/tenant/session and provider metadata. It is a provider-neutral boundary designed for FCM. No Firebase SDK, private key or Android implementation is present in this repository. A future delivery provider must decrypt only server-side and call FCM after notification authorization.

## Migration and deployment

Apply [2026-09-21-shopkeeper-mobile-platform.sql](../database/migrations/2026-09-21-shopkeeper-mobile-platform.sql), then deploy. Required server configuration: existing `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, DB credentials and HTTPS. Never put any of these values, Meta credentials, app secrets or DB credentials into Android.

The migration is additive. The runtime initializes mobile/profile tables as a deployment fallback, but production deployments should apply the migration with the normal database process. The `tenant_type` ALTER should be applied only once by the migration runner.

## Remaining before Android UI

1. Implement native MFA challenge completion for MFA-enabled users.
2. Migrate/create tenant-owned Shopkeeper product and order domains before enabling those endpoints.
3. Add an FCM delivery provider and Firebase credentials in the server secret store.
4. Add cursor pagination to very large WhatsApp datasets and production distributed rate limiting.
5. Create the separate Android repository; it must only use these HTTPS APIs.
