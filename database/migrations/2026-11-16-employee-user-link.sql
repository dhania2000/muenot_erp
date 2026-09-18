-- SPEC 15 — Employee ⇄ User link.
--
-- Establishes the durable relationship between HR employees and login users:
--   * `users.account_type`      — 'person' (default) or 'service' (no employee).
--   * `hr_employees.user_id`     — one employee → at most one login user.
--   * `hr_employees.entity_id`   — legal entity the employment belongs to, so a
--                                  single user can be linked to several employee
--                                  rows across different entities (multi-entity)
--                                  while duplicates within one entity are blocked.
--   * `employee_user_link_events`— append-only audit of link/unlink/account-type
--                                  changes and access-status synchronizations.
--
-- Additive and idempotent: the DB layer (lib/employee-user-link.ts) self-heals
-- the same objects at runtime, so this file is safe to (re)apply by hand.

ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `account_type` VARCHAR(20) NOT NULL DEFAULT 'person';

ALTER TABLE `hr_employees`
  ADD COLUMN IF NOT EXISTS `user_id` INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `entity_id` INT UNSIGNED DEFAULT NULL;

ALTER TABLE `hr_employees` ADD INDEX IF NOT EXISTS `idx_hr_user` (`user_id`);
ALTER TABLE `hr_employees` ADD INDEX IF NOT EXISTS `idx_hr_entity` (`entity_id`);

CREATE TABLE IF NOT EXISTS `employee_user_link_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` INT UNSIGNED DEFAULT NULL,
  `employee_pk` INT UNSIGNED DEFAULT NULL,
  `user_id` INT UNSIGNED DEFAULT NULL,
  `action` VARCHAR(40) NOT NULL,
  `detail` JSON DEFAULT NULL,
  `actor_id` INT UNSIGNED DEFAULT NULL,
  `actor_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_eul_tenant` (`tenant_id`, `created_at`),
  KEY `idx_eul_user` (`user_id`),
  KEY `idx_eul_emp` (`employee_pk`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
