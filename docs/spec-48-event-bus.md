# Central business events

## Inventory

| Event | Existing source / integration boundary | Publisher status |
| --- | --- | --- |
| employee.created / employee.updated | HR employee routes and `hr_employee_events` audit log | Inventoried; not connected |
| invoice.created | `billing-engine.createInvoice`; header, lines and credits currently use multiple writes | Inventoried; requires whole-operation transaction before publishing |
| payment.received | Billing payment recording plus gateway settlement updates | Inventoried; requires one canonical settlement transaction |
| vendor.created | Finance vendor CRUD | Inventoried; requires verified tenant-owned mutation boundary |
| leave.approved | HR / approval-authority transitions | Inventoried; retain existing approval authority |
| deal.won | `sales/lead-lifecycle.markLeadWon` | Connected, transactional |
| subscription.renewed | Subscription engine renewal mutation and separate history writes | Inventoried; requires canonical renewal transaction |
| file.uploaded | Central file metadata create/update and completion transitions | Connected, transactional |

This increment implements the reusable bus, two production publisher adapters, two subscriber types, and monitoring. It does **not** claim all nine example events are wired. Unconnected publishers are explicitly labelled in the UI and cannot be subscribed to. No historical scan/backfill is run.

## Model and delivery semantics

- `erp_business_events`: tenant, event type, schema version, record ID, actor, source key, immutable identity hash and timestamp. No document contents, tokens, payment details or full business records are copied.
- `erp_event_subscriptions`: tenant-owned reviewed handler configuration; append new subscriptions to change targets. Enable/disable affects future publications only.
- `erp_event_deliveries`: one row per event/subscriber, frozen configuration, attempt count, due time, result and status.
- `erp_event_delivery_log`: append-only attempt outcomes and manual-retry audit.

Publishers call `publishEvent(connection, event)` on the **same MySQL connection and transaction** as the business change. Schema preparation runs before the transaction. The event and subscriber fan-out roll back if the source mutation fails, and vice versa. The worker cannot observe uncommitted events.

The event identity is unique per tenant/type/source key. Repeating an identity for the same record returns the original event. Reusing it for another record fails. A persisted fan-out marker prevents duplicate publication from enlisting subscribers added later, including events originally published with no subscribers.

Each delivery is row-locked; its database effect and terminal status commit together. A crash before commit rolls back both, so another worker can safely try again. Failed effects roll back to a savepoint before an attempt is recorded. Automatic retries use exponential delay, up to five total attempts. Failed deliveries can be retried once by a tenant admin using the expected current attempt; history and original identity are retained.

Handlers never perform network calls inside delivery transactions:

1. **In-app notification** enqueues one notification delivery for a validated active tenant member. Subscriber success means queued; the notification worker subsequently creates the existing bell record after rechecking preferences and membership.
2. **Start Sales workflow** accepts `deal.won` only, snapshots a manual Sales workflow at subscription creation, and atomically enqueues a run with its business-event history entry. The existing workflow worker executes it later. Conditions evaluate against current record state when the workflow runs, not historical event-time field values. Delivery success means “run enqueued”, not “workflow completed”.

Subscriber owner authority is checked again on delivery. Revoked owners, moved recipients, missing source records and disabled/deleted workflows fail closed. Subscriptions cannot invoke arbitrary handlers, SQL, URLs or commands. HTTP clients cannot publish business events.

## Publisher details

- Winning a lead now locks and verifies the source tenant before idempotency handling. Its event key includes the resulting row version. Repeating Won on an already-Won lead does not emit another win; reopening and winning again is a distinct transition.
- Completed file metadata and its event are written together. Pending/failed uploads do not emit completion. Re-recording the same completed file ID deduplicates; a new file/version ID can emit a new event. This covers the metadata registry paths, not legacy uploads that bypass it. The event reports upload completion, not malware scan clearance.
- Existing invoice/payment/renewal paths are intentionally not given best-effort post-commit hooks: those can silently lose events or create duplicate financial effects on retry. Future adapters must supply a transaction-safe boundary.

## Monitoring and deployment

Open `/admin/automation/events` for the bus inventory, subscriber configuration, events, per-subscriber delivery status, retries and history. The former workflow-run monitor is retained in a separate expandable section. Automation overview's event counts now refer to actual business events (last 24 hours) and failed deliveries, not workflow runs.

Apply `database/migrations/2026-09-20--event-bus.sql` before rollout; runtime also ensures the additive tables. Existing notification and workflow schemas remain prerequisites. Enable the new `business_events` scheduler job and set `CRON_SECRET`; its endpoint fails closed without the secret even in development. The worker processes at most 30 due deliveries per tick.

Local commit `ac87d9c` remains on the prior local main branch. is based on GitHub `1a293e4`, preserving that version's workflow builder, Automation Center and security changes.

## Verification

Tests cover event contracts, duplicate fan-out, tenant predicates, identity conflict, delivery rollback/retry, immutable subscriber configuration, API authorization and transactional file/Sales publisher calls using a mocked database. They do not establish real MySQL locking or browser behavior.

Staging checklist: subscribe a second tenant user, win an owned lead, complete an upload, verify notifications/run links; repeat publication and concurrent workers; inject a transaction rollback and verify no event survives; revoke recipient access and verify failed delivery; retry with matching/stale attempt values; confirm another tenant cannot inspect or retry those deliveries. Do not use live customer delivery as a smoke test.
