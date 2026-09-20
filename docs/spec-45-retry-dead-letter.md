# SPEC 45 — Retry and dead-letter handling

The common retry policy distinguishes temporary rejection/service failures from
permanent errors and uncertain delivery. SMTP 4xx, HTTP 429/5xx and connection
refusal retry with capped exponential backoff. SMTP 5xx, authentication and
HTTP client errors stop immediately. Unknown failures, dropped connections and
timeouts are uncertain and require review. Retry counts remain durable.

Background jobs enter dead_letter when retries exhaust or automatic retry is
unsafe. The worker writes its terminal event in the same locked transaction as
the status. The background jobs console polls these durable events every 15
seconds, displays failure notices and deduplicates toast notifications during
the mounted session. Notices remain visible until jobs leave the dead-letter
state. This is in-app notification delivery while the console is open, not
email delivery. Existing scheduler failure email notifications continue.

Super Admin can filter dead-letter jobs and authorize one additional attempt.
POST /api/platform/background-jobs/:id/retry verifies role, locks the job,
checks the expected attempt and terminal state, and records actor ID. It
preserves job ID, idempotency key, attempt history and payload. Uncertain or
legacy outcomes require acknowledgement; this is not an exactly-once provider
guarantee. Fix permanent errors before retrying. Lifetime attempts cap at 254.

Scheduler HTTP executions use the same classifier to stop permanent or unknown
failures; existing retry limits/backoff and failure notifications remain.
Manual retry and dead-letter filtering apply to background queue jobs.
No schema migration is needed: existing status, result and event fields store
the policy decisions.
