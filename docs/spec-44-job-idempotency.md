# SPEC 44 — Job idempotency

Inventory and protections:

* Provision installments: source schedule row ID is the business key.
* Depreciation: globally unique asset row ID plus accounting period is the key.
* Both use postLines receipts; journal, ledger, source-state and result commit
  together. Concurrent identical calls replay the committed result; conflicting
  data with the same key fails. Rollback removes the receipt with the effects.
  These source row IDs are database-global and identical for manual/cron callers.
* Scheduler: configuration-row lock serializes concurrency admission; existing
  unique job/minute key detects duplicate ticks.
* Queue: unique type/tenant/key detects duplicate enqueue; changed payloads are
  rejected. Long keys are hashed rather than truncated. Each attempt has a UUID;
  row-locked settlement verifies UUID and attempt before changing status and
  records the event atomically. Stale workers cannot finish newer attempts.
* Payment gateways already accept provider idempotency keys. Other financial
  posting paths are not automatically opted in: reversal/repost identity must
  be specified explicitly when adopting the new postLines boundary.

The receipt helper requires an existing transaction and a callback using its
connection; external requests and schema DDL must stay outside it. Do not delete
receipts while their business entities can still be retried.

Email transport is not transactionally atomic with MySQL. Timeout or worker-loss
recovery therefore dead-letters an uncertain send instead of automatically
resending it. A provider response failure can still be ambiguous; this is not
an exactly-once guarantee for external providers.

Legacy postings are not backfilled. Existing posted-state/period checks remain.
Historical inconsistencies require reconciliation; this migration does not
change historical ledger data.
