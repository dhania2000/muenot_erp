-- Spec48 follow-up — idempotent export creation.
--
-- A client retry carrying the same Idempotency-Key (per tenant + requester)
-- replays the original export job instead of rendering and auditing a second
-- artifact. lib/data-export-store.ts self-heals the same shape at runtime.

ALTER TABLE `data_export_jobs`
  ADD COLUMN `idempotency_key` VARCHAR(120) DEFAULT NULL,
  ADD UNIQUE KEY `uq_export_job_idem` (`tenant_id`, `requested_by`, `idempotency_key`);
