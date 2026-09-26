-- Spec40 (#132-134, #227-229): Master data & configuration inheritance.
-- Adds two subsystems on top of the existing org-hierarchy, tenant settings and
-- maker-checker governance (no duplicate subsystems):
--   1. setting_overrides  — per-scope policy overrides that inherit
--        global -> company -> branch -> department -> user.
--   2. identity_map / identity_merge_log — unify employee/company/party
--        identities across modules by stable id, with append-only merge history.
-- All tables are tenant-scoped. Additive and safe to re-run.

-- 1. Inherited policy overrides -------------------------------------------------
-- One row per (tenant, policy_key, scope_level, scope_id). Global overrides use
-- scope_id = 0 so the unique key holds (MySQL treats NULLs as distinct).
CREATE TABLE IF NOT EXISTS setting_overrides (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id    INT NOT NULL,
  policy_key   VARCHAR(120) NOT NULL,
  scope_level  ENUM('global','company','branch','department','user') NOT NULL,
  -- org_unit id for company/branch/department, user id for user, 0 for global.
  scope_id     INT NOT NULL DEFAULT 0,
  svalue       TEXT NULL,
  updated_by   INT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_setting_override (tenant_id, policy_key, scope_level, scope_id),
  KEY idx_setting_override_lookup (tenant_id, policy_key, scope_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Identity map ---------------------------------------------------------------
-- Every module reference to a real-world entity points at a canonical identity
-- key ("<kind>:<id>"). A merge re-points merged references to the survivor key.
CREATE TABLE IF NOT EXISTS identity_map (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT NOT NULL,
  identity_kind  ENUM('employee','company','party') NOT NULL,
  canonical_key  VARCHAR(64) NOT NULL,
  source_module  VARCHAR(40) NOT NULL,
  source_id      INT NOT NULL,
  external_ref   VARCHAR(190) NULL,
  status         ENUM('active','merged') NOT NULL DEFAULT 'active',
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- One mapping per (tenant, kind, module, source id): re-mapping is idempotent.
  UNIQUE KEY uq_identity_source (tenant_id, identity_kind, source_module, source_id),
  KEY idx_identity_canonical (tenant_id, identity_kind, canonical_key),
  KEY idx_identity_external (tenant_id, identity_kind, external_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Identity merge history -----------------------------------------------------
-- Append-only record of every merge, with the collisions acknowledged and a
-- per-tenant idempotency key so a retried merge never double-applies.
CREATE TABLE IF NOT EXISTS identity_merge_log (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id        INT NOT NULL,
  identity_kind    ENUM('employee','company','party') NOT NULL,
  survivor_key     VARCHAR(64) NOT NULL,
  merged_key       VARCHAR(64) NOT NULL,
  collisions       JSON NULL,
  acknowledged     TINYINT(1) NOT NULL DEFAULT 0,
  actor_user_id    INT NULL,
  idempotency_key  VARCHAR(200) NOT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_identity_merge_idem (tenant_id, idempotency_key),
  KEY idx_identity_merge_survivor (tenant_id, identity_kind, survivor_key),
  KEY idx_identity_merge_merged (tenant_id, merged_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
