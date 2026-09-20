# SPEC 49 — Notification engine

## Scope and migration audit

The centralized service owns templates, per-user channel preferences, queued delivery, priority, UTC scheduling, bounded retry and tenant-scoped monitoring.

| Existing path | Integration in this increment |
| --- | --- |
| Automatic activity and explicit activity notifications | Enqueue in-app deliveries; retain actor, module, action and entity metadata |
| Workflow notice / approval notice | Enqueue on the workflow transaction, retaining the workflow notice record |
| Business-event notice subscriber | Enqueue on the event delivery transaction |
| Existing notification bell | Reads the existing notifications table; populated by the new worker |
| Workflow email/WhatsApp actions and other direct email/WhatsApp integrations | Unchanged; not yet migrated to the centralized delivery service |

This is not a claim that every email, campaign or transactional message in the repository has been migrated. Activity capture remains best-effort/fire-and-forget relative to the source business write; workflow and event enqueue operations share their source transactions. No historical backfill is performed.

## Channels and preferences

- In-app: enabled by default; writes the existing bell record and delivery receipt in one transaction.
- Email: opt-in; uses the user's current tenant-owned profile email and existing platform SMTP configuration. Plain-text template content is HTML-escaped. SMTP credentials must be configured; email is not tenant-specific SMTP in this increment.
- WhatsApp: opt-in; uses the tenant's connected integration and the existing text-message sender. Meta session-window rules apply; these local notification templates are not Meta-approved WhatsApp message templates.
- SMS / push: opt-in architecture and server-side provider interface. They remain blocked until a reviewed provider is registered through registerNotificationProvider. No fake success or arbitrary client-supplied provider URL.
- External phone/device destinations are self-managed preferences; phone ownership verification and push-device registration are not implemented. Do not enable sensitive external notifications until the deployment adds verified destinations.

Preferences and active tenant membership are checked again at delivery, so opting out after scheduling suppresses the pending message. External channels default off. Email destinations cannot be overridden by a send request. An employee can edit only their own preferences.

## Delivery contract

Templates are immutable plain-text records with required named variables such as {{name}}. Queuing snapshots rendered content. A tenant/channel/request key identifies the delivery; same-key same-content replay returns the existing ID, changed content is rejected.

The worker processes five due records per invocation, priority 10 before 5 before 0. Each claim is row-locked. Network calls run outside database transactions, with a unique lease and a 20-second timeout. Provider completion only settles the matching lease.

- queued: pending, scheduled or transiently rejected; exponential retry starts at 30 seconds, with at most five automatic attempts.
- delivered: in-app database delivery committed.
- accepted: external provider accepted the request; **not proof of device delivery or reading**.
- skipped: recipient removed/inactive or channel disabled.
- blocked: missing provider/configuration/destination.
- failed: permanent rejection or exhausted retries.
- uncertain: timeout, ambiguous provider error or interrupted worker; never automatically resent.

Sending leases older than five minutes are quarantined as uncertain. Their current error is visible in monitoring; stale recovery currently updates the delivery row without a separate history entry. Tenant admins may explicitly retry failed/blocked records using the expected attempt counter. Accepted/uncertain records cannot be retried through this API. Identities and attempt history remain intact.

Exactly-once external delivery is not promised. A provider may accept before connection loss or timeout; reconciliation and verified provider delivery webhooks are future work. Built-in transports may continue after the local timeout, which is why those records are quarantined.

## Operations

1. Apply database/migrations/2026-09-21-spec49-notification-engine.sql before deployment, or allow the existing lazy schema initializer to create the four tables. Preserve the existing notifications table.
2. Configure CRON_SECRET and enable the notification_delivery scheduler job (every minute), or call /api/cron/notification-delivery with Bearer authentication. Do not run unauthenticated cron requests.
3. Configure SMTP / tenant WhatsApp before enabling those channels. Register reviewed SMS/push adapters in server initialization if needed.
4. Tenant admins manage templates, queue/schedule notifications and inspect delivery/history at /admin/automation/notifications.
5. Users manage preferences at /notifications/preferences. Admins also see their own preferences in the monitoring screen.

The worker must run for the migrated in-app paths to reach the bell. The existing workflow/event workers still run separately. Event subscriber success now means notification queued, not bell delivery.

## Verification and remaining deployment checks

Automated tests use mocked database/provider boundaries: tenant and actor isolation, idempotency conflict, source metadata, preferences, scheduling, row-lock protocol, leases, retry classification, terminal-state no-replay, monitoring scope, API origin checks and cron authentication. No test sends real email, SMS, WhatsApp or push.

Real MySQL transaction/rollback/concurrency checks, live UI testing and provider acceptance/delivery testing remain deployment checks. The repository's unrelated pre-existing TypeScript errors prevent claiming a clean whole-project build.
