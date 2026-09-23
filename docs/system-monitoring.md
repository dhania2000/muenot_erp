# System Monitoring and Observability

This is application telemetry, not a Hostinger infrastructure log reader. The existing Health & Jobs, Job Monitoring, Security Audit, WhatsApp, and scheduler subsystems remain the sources of truth for their respective operational data. The new console is limited to platform Super Admins and does not grant a tenant access to other tenants' records.

## Deployment

1. Apply `database/migrations/2026-12-09-system-monitoring.sql` to the same MySQL database as the ERP before deploying the code. The migration only creates new tables and can be replayed safely.
2. Deploy the application. The scheduled `monitor_retention` job joins the existing central dispatcher. It requires the existing `CRON_SECRET`; no new credentials are needed.
3. Open `/platform/system-monitoring` as a platform Super Admin. The dashboard reflects only events generated after deployment; prior Hostinger logs are not imported.
4. Confirm health and one safe test event in a staging environment. Monitoring writes use explicit UTC timestamps; the console renders them in the browser's timezone. Set `APP_ENV=production` on production and `APP_ENV=staging` on staging to keep incidents separate.
5. Do not enable DEBUG/INFO persistence in production until retention and volume have been reviewed. The default threshold is WARNING.

No optional Hostinger adapter is enabled. A future provider adapter should expose `isAvailable()` and `fetchLogs()` against an officially supported machine-readable API, then pass normalized results through the same redaction layer. Do not scrape hosting HTML or store panel credentials.

## Architecture

`monitorLogger` in `lib/system-monitoring.ts` accepts structured events. It first checks the configured minimum severity, redacts messages and nested metadata, rate-limits repeated low-severity events, then persists to `system_logs`. ERROR/CRITICAL events upsert a fingerprinted incident in `system_incidents`. Tenant counts use a unique link table. A monitoring storage failure falls back to a sanitized console notice; it never recursively invokes the logger or blocks the main business operation. Existing security/audit logs remain independent and are not weakened by this best-effort logger.

The logger uses the shared MySQL pool directly, bypassing the `lib/db.ts` wrapper to prevent recursive failure capture and activity notifications. Database errors captured by that wrapper include only driver error code and SQL state, never SQL text or parameters. Existing WhatsApp signup, mobile onboarding, registration, auth login server failures, cron dispatcher, WhatsApp webhook failures, email sends, FCM delivery failures, and subscription reconciliation failures emit centralized events. Expected user-input 4xx responses are not incidents. Routine successful heartbeats are not persisted.

The tenant isolation guard retains its report/enforce behavior but no longer prints SQL statements into console logs. Report-mode events are rate-limited WARNING records; enforced blocks create ERROR incidents. This does not relax tenant isolation.

Requests matched by middleware receive a newly generated `x-request-id` header. Incoming client-supplied IDs are overwritten. Existing audit and integrated error paths can use that ID for correlation. The header is not an authentication credential.

The root Next.js `instrumentation.ts` uses the documented `onRequestError` hook to capture unhandled Node.js route/render errors. It intentionally stores a generic safe message and route metadata, not raw exception text, request headers, or request bodies. Expected handled validation responses remain outside this hook.

## Severity and usage

DEBUG: local troubleshooting; INFO: routine operational event; NOTICE: noteworthy change; WARNING: degraded/retryable condition; ERROR: failed operation; CRITICAL: broad production outage or security-critical failure. Only WARNING and above persist by default.

```ts
import { monitorLogger } from "@/lib/system-monitoring"

monitorLogger.error({
  service: "billing",
  component: "renewal",
  operation: "charge",
  errorCode: "PAYMENT_PROVIDER_UNAVAILABLE",
  message: "Renewal charge failed",
  tenantId,
  requestId,
  metadata: { provider: "example", httpStatus: 503 },
})
```

Do not pass raw request bodies, response bodies, webhook payloads, SQL, headers, tokens, or credentials. Redaction covers common secret-key variants recursively, token-like strings, authorization headers, signed URL parameters, and card-number-like strings, but callers must still provide safe diagnostics rather than relying on redaction as the sole control.

Fingerprints use environment, service, component, operation, error code (or normalized message). Repeated errors increment one incident. A new occurrence reopens a resolved incident. Incident actions and notes record the Super Admin actor. Alert rules currently deliver deduplicated, cooldown-controlled **in-app** records; email/WhatsApp delivery is deliberately not claimed until a safe reviewed transport is connected. No credential storage is added.

## APIs and data handling

All `/api/platform/system-monitoring/*` routes require `platform_super_admin` server-side. Resources: `dashboard`, `logs`, `logs/:id`, `incidents`, `incidents/:id`, `incidents/:id/action`, `health`, `alerts`, `settings`, `export`. Log and incident lists use descending ID cursors and a maximum page size of 100. CSV export is capped at 100 rows per call and audited. Incident status changes, settings changes, and rule creation are audited. No tenant-facing monitoring API exists.

The dashboard charts query persisted events for 1h, 6h, 24h, 7d or 30d. Short ranges aggregate by hour; 7d/30d aggregate by day so the visual is not silently truncated by the result cap. Counts cover captured application events, not every request processed by the ERP.

The health view combines the existing real database/auth/runtime checks with configuration-presence checks for WhatsApp, SMTP, FCM, and cron. A missing optional integration is UNKNOWN, not a fabricated failure. It does not verify an external provider's actual availability. The existing job-monitoring and scheduler screens continue to present authoritative job-run detail.

## Retention and troubleshooting

Default retention: DEBUG 7d, INFO/NOTICE 30d, WARNING 90d, ERROR 180d, CRITICAL 365d. The hourly scheduler deletes at most 1,000 rows per run. Incident summaries are retained separately. Super Admins can change retention and minimum severity in Settings. If logs are absent, check the migration, database connectivity, minimum severity, the current `APP_ENV`, and the sanitized `[system.monitoring] persistence unavailable` line in server logs. Do not paste raw Hostinger logs into monitoring records if they contain credentials.

Application-generated failures outside the integrated paths will require incremental instrumentation. Next.js process crashes, container restarts, web-server access logs, MySQL server internals, network infrastructure, and Hostinger panel logs are **not** available through this module without a supported external provider feed.
