# Central scheduler inventory

The platform has one scheduler trigger at `/api/cron/dispatcher`. It loads the reviewed job allow-list, selects due work, claims an idempotent run slot, invokes the internal endpoint with a timeout, retries according to policy, and records the result in `platform_cron_runs`.

## Current inventory

| Category | Registered jobs |
| --- | --- |
| Reports | Operations monitoring |
| Notifications | Notice board, knowledge base, call cleanup, recruitment reminders, asset reminders |
| Billing | Payment, provisions, depreciation, loan, investment, related-party and subscription jobs |
| Data sync | Calendar sync |
| Storage cleanup | Storage retention, marketing library |
| Payroll | Extension slot — no existing job was registered in the repository |
| GST / TDS | Daily/monthly GST, daily/monthly/quarterly TDS |
| Email campaigns | Sales, finance, journeys and planner queues |
| Integrations | Contracts, e-signature, WhatsApp and background-queue workers |
| AI tasks | Extension slot — no existing job was registered in the repository |

Platform staff can inspect the inventory and recent runs at `/platform/scheduler`; schedule policy editing remains restricted to `/platform/cron-jobs` for platform super admins.
