# SPEC 50 — Central Email Engine

## Existing functionality reused

- `lib/email.ts`: SMTP/Gmail transport, RFC 5322 threading and the existing attachment store.
- `lib/background-jobs.ts`: durable queue, exponential retry, idempotency and terminal failure handling.
- Module template and email hubs: Sales/CRM, HR, Finance, Recruitment and Operations continue to own their existing screens and records.

## New shared service

`lib/email-engine/service.ts` is the shared entry point for new CRM, HR, Finance and system flows:

```ts
await queueTenantEmail({
  tenantId, actorId, module: "finance", to, subject, html,
  replyToMessageId, attachments, trackingConsent, idempotencyKey,
})
```

It writes a tenant-scoped message ledger, resolves a tenant sender profile, carries trusted thread headers into the existing queue, and records provider acceptance or the terminal failure. The worker, not an HTTP client, performs delivery.

## Security and privacy

- Tenant identity is taken from the authenticated server context in the administrative APIs; clients cannot supply it.
- Sender configuration contains display/routing metadata only. SMTP/Gmail secrets remain in the existing encrypted settings/environment store.
- Attachments are referenced through the existing attachment API and resolved only by the queue worker; binary data is never written to job JSON.
- Tracking is opt-in (`trackingConsent: true`). With no consent, no tracking token or pixel is created.
- Open events represent a pixel request, not a guaranteed human read. Provider webhooks can update delivered/bounced status in the same ledger when configured.

## HTTP endpoints

- `GET /api/admin/automation/email-engine` — tenant-admin activity ledger.
- `PUT /api/admin/automation/email-engine` — tenant-admin sender profile.
- `POST /api/admin/automation/email-engine/queue` — tenant-admin system/module message queueing.
- `GET /api/email/track/:token` — consent-gated transparent open pixel.

## Migration

Run `database/migrations/2026-09-21-spec50-email-engine.sql`. The service also creates the same tables idempotently for existing installations.

## Delivery status

`queued → accepted` means the SMTP/Gmail provider accepted the message. `delivered` and `bounced` require a configured provider webhook; a successful transport response alone cannot truthfully claim inbox delivery.
