# Job monitoring

Super Admin: /platform/job-monitoring and /api/platform/job-monitoring.
Tenant administrator: /admin/job-monitoring and /api/admin/job-monitoring.
Roles are resolved from the database. Tenant IDs come from the verified role
context, never query parameters. Tenant responses exclude global cron sweeps.

The common read model combines cron runs and background jobs without copying
their state. It maps succeeded to completed and dead-letter to failed with a
separate flag. Retried counts executions with attempts > 1; queued retry jobs
remain queued until another attempt starts. Background duration is elapsed
time from first start, including backoff; queued, never-started jobs have no duration.
New queue producers persist scheduler, user_request or system trigger sources.
Historical sources remain unknown; no ownership is inferred from payloads.

The UI refreshes every 15 seconds, supports 50-row pagination, shows total
status counts, and visibly retains stale data on refresh failure. Live in-app
alerts show failures from the last 24 hours, queued jobs overdue by 15 minutes,
background runs past timeout, and scheduled runs older than 30 minutes.
Alerts use the same tenant scope as the list, independently of pagination.
They are visible while the page is open; no email or push alerts are added.
Existing scheduler failure notifications continue separately.

Responses use explicit metadata projections and safe error classifications,
never email bodies, credentials, reset URLs, idempotency keys or raw provider errors.
Existing queue list/cancellation responses are also sanitized.

Apply the migration before the migration. Runtime initialization
also adds the trigger-source column idempotently for existing installations.
