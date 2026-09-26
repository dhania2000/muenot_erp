-- Spec38 follow-up: idempotent policy-version publishing.
-- A retried "publish new version" request carrying the same Idempotency-Key
-- returns the version it already created instead of creating another one.
-- Additive; NULL keys (legacy rows / keyless requests) never collide.

ALTER TABLE training_policy_versions
  ADD COLUMN idempotency_key VARCHAR(80) DEFAULT NULL;

ALTER TABLE training_policy_versions
  ADD UNIQUE KEY uq_training_policy_version_idem (tenant_id, policy_id, idempotency_key);
