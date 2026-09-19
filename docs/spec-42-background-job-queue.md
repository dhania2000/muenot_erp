# SPEC 42 — Background job queue

The durable queue lives in `platform_background_jobs` and is processed by the reviewed `/api/cron/background-queue` worker through the central scheduler. It supports priority ordering, idempotency, retry with exponential backoff, per-key concurrency limits, timeouts, cancellation, and a dead-letter state after the configured retry limit.

## Existing asynchronous inventory

| Workload | Queue state |
| --- | --- |
| Password-reset and scheduler failure notification e-mails | Migrated to `email.send` jobs |
| Sales and finance e-mail queues | Existing scheduled producers; can enqueue the reviewed `email.send` job type as handlers are migrated |
| Reports, exports, integrations and AI | Future handlers use the same reviewed job registry; no arbitrary callable URL or command can be inserted |

The queue API deliberately does not allow HTTP clients to pick executable code. New job types require a reviewed payload validator and handler in `lib/background-jobs.ts`.
