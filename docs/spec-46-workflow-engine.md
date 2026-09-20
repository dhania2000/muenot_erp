# SPEC 46 — Reusable workflow engine

## Audit and integration boundary

The existing code has four distinct automation paths:

| Implementation | Existing responsibilities | SPEC 46 decision |
| --- | --- | --- |
| `lib/marketing/journeys-engine.ts` | Marketing enrollment, audience rules, journey steps | Retain; do not migrate active journeys implicitly |
| `lib/finance-expense-workflow.ts` / `lib/approval-authority.ts` | Expense lifecycle, approval tiers, segregation of duties, posting | Retain as domain authority; engine cannot update financial state |
| `lib/operations-task-automation.ts` / `lib/recruit-task-automation.ts` | Module-specific task generation | Retain; some legacy tables lack verified tenant isolation, so not exposed as generic writable tables |
| SPEC 40–45 scheduler / queue | Due work, retries, job monitoring | Register a reviewed workflow worker in the existing scheduler |

The first reviewed adapters are **Sales leads** and **cross-module workflow tasks**. Sales detail links into the workflow console with its record ID. Source lookup and writes require both tenant ID and record ID. Sales priority/assignment changes increment `row_version`; assignment appends owner history. Won/lost state, payments, ledger entries and arbitrary SQL are not writable actions.

## Supported in this increment

- Tenant-admin form builder at `/admin/workflows`, linked from Admin overview.
- Reusable immutable definitions; each run stores an immutable definition snapshot.
- Explicit on-request and one-off scheduled triggers for an existing source record.
- AND conditions using reviewed fields with equals, not-equals and contains.
- Ordered notifications, approval gates, delays, UTC scheduled actions, named webhooks, field updates, task creation and record assignment.
- Notification delivery into the existing notification bell as well as the workflow inbox.
- Creation produces an `erp_workflow_tasks` record linked to its source run; it does not create arbitrary ERP/financial records. Further workflows can target these records.
- Pending approval, run history, task list and cancellation of remaining actions. Cancellation is not compensation for earlier effects.

Nested conditions/OR/ELSE, visual branching and dry-run designer are SPEC 47, not part of this builder. Automatic record-change/event subscriptions are reserved for the central event architecture in SPEC 48; this increment does not claim event-driven integration of every ERP module. Scheduled triggers are explicit one-off run requests, not recurring per-definition schedules.

## Execution and safety

- APIs derive tenant from the database-backed tenant-admin guard, never body parameters. Requester must be an active admin/owner of that tenant, including at execution time. Platform operators without tenant membership cannot launch runs merely by impersonating a tenant.
- One run is row-locked for each step. Local mutations, event entry and cursor update commit in one transaction. Savepoint rollback removes partial effects before recording failure.
- Request keys are unique per tenant/workflow and bind record, actor and scheduled time by hash. Same input replays its run ID; changed input is rejected.
- Conditions are evaluated at execution start, not against an old browser snapshot. Later steps use current source data but do not re-evaluate the initial condition set.
- Approval pauses at its step. Only the designated active tenant admin can decide. Requester cannot approve their own run. Rejection terminates it.
- Delays/schedules are persisted, not sleeps. Times are stored as UTC SQL strings, avoiding application-host timezone conversion.
- A worker advances at most 20 runs by one action per tick. Default scheduler tick is one minute; a multi-step workflow can therefore take several minutes.
- Failed actions stop the run. No generic retry button or automatic re-execution of completed steps is provided. Investigate completed effects before starting a replacement run.
- Webhook intent commits before I/O. A timeout, rejection, process crash or uncertain delivery stops the run; it is never automatically resent. The receiver gets a stable idempotency key. Abandoned dispatches are quarantined after five minutes.
- Webhook payload contains only tenant/run/step/record IDs, not full business records or tokens. Destinations are deployment-managed per tenant, HTTPS only, with public IPv4 DNS validation, checked-address pinning, no redirects, and a ten-second request deadline. IPv6-only and private destinations are intentionally unsupported.

## Deployment / testing

1. Apply `database/migrations/2026-09-20-spec46-workflow-engine.sql`. Runtime also creates these additive tables idempotently and ensures the existing notifications schema. Existing Sales lifecycle and tenant-isolation migrations must already be applied.
2. Set `CRON_SECRET`; the new worker fails closed even in development without it. Ensure the central dispatcher is running and `workflow_worker` is enabled in scheduler configuration.
3. Optional webhook configuration: `WORKFLOW_WEBHOOK_TARGETS={"TENANT_ID":{"crm":"https://your-reviewed-public-host.example/hook"}}`. Replace placeholders with the actual tenant ID and reviewed endpoint; never store secrets in the workflow definition. Deployment admins control this allowlist.
4. Sign in as a tenant admin, create a workflow, choose a source lead owned by that tenant, and start it. Use another active admin as approver. Confirm approve/reject, notification delivery, field/owner history, created task, delay, scheduled start and cancellation.
5. Attempt another tenant's record/workflow IDs; verify rejection. Submit the same request key twice; verify one run. Test concurrency/crash recovery against staging MySQL before production rollout.

Automated tests cover model validation, tenant predicates, execution transaction protocol, approval restriction, delay persistence, idempotent replay and uncertain-webhook handling with a mocked database. They do not substitute for real MySQL concurrency, browser or live webhook delivery tests.
