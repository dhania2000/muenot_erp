-- Spec41 (#135-139, #218-219): Central documents, messages & provider services.
-- Central, tenant-scoped communication governance shared by every outbound
-- channel (notification engine, email engine, WhatsApp, internal calling) — no
-- duplicate transport subsystems are introduced. This migration only adds the
-- governance tables that lib/comms-governance/schema.ts self-heals at runtime;
-- keeping the two in lockstep so a fresh environment and a migrated one match.
-- All tables are tenant-owned and every runtime query carries a tenant_id
-- predicate. Additive and safe to re-run.

-- 1. Per-tenant provider configuration -----------------------------------------
-- One row per (tenant, channel). No row = platform default (enabled, shared
-- transport, no tenant limit). Secrets are NEVER stored here: credential_ref
-- points at the tenant secrets vault. version powers optimistic concurrency.
CREATE TABLE IF NOT EXISTS tenant_comm_providers (
  tenant_id     BIGINT UNSIGNED NOT NULL,
  channel       VARCHAR(20)  NOT NULL,
  provider      VARCHAR(30)  NOT NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  credential_ref VARCHAR(120) NULL,
  settings_json JSON         NULL,
  hourly_limit  INT UNSIGNED NULL,
  daily_limit   INT UNSIGNED NULL,
  version       INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by    BIGINT UNSIGNED NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Suppression list (bounce / complaint / opt-out / manual) -------------------
-- The raw address is never stored: address_hash is the lookup key and
-- address_masked is a PII-safe display value. A consent withdrawal (complaint /
-- opt_out) can only be lifted by the recipient re-opting in. released_at IS NULL
-- means active. The unique key makes repeat events idempotent (bump hit_count).
CREATE TABLE IF NOT EXISTS tenant_comm_suppressions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  channel        VARCHAR(20)  NOT NULL,
  address_hash   CHAR(64)     NOT NULL,
  address_masked VARCHAR(80)  NOT NULL,
  reason         VARCHAR(20)  NOT NULL,
  hit_count      INT UNSIGNED NOT NULL DEFAULT 1,
  source         VARCHAR(40)  NOT NULL,
  provider_event_id VARCHAR(190) NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at    DATETIME     NULL,
  released_by    BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_comm_suppression (tenant_id, channel, address_hash, reason),
  KEY idx_comm_suppression_active (tenant_id, channel, released_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Per-tenant send-limit counters --------------------------------------------
-- One row per (tenant, channel, window). The conditional UPDATE in
-- reserveSendSlot makes concurrent workers unable to overshoot a limit.
CREATE TABLE IF NOT EXISTS tenant_comm_send_counters (
  tenant_id    BIGINT UNSIGNED NOT NULL,
  channel      VARCHAR(20)  NOT NULL,
  window_kind  VARCHAR(4)   NOT NULL,
  window_start DATETIME     NOT NULL,
  sent         INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, channel, window_kind, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Provider event dedupe ledger ----------------------------------------------
-- Every ingested bounce/complaint/delivery carries a provider-unique id. The
-- unique key drops duplicate provider retries (duplicate-delivery protection).
-- The tenant is derived from the platform's own sent message, never the payload.
CREATE TABLE IF NOT EXISTS tenant_comm_provider_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  provider     VARCHAR(20)  NOT NULL,
  provider_event_id VARCHAR(190) NOT NULL,
  event_type   VARCHAR(20)  NOT NULL,
  address_hash CHAR(64)     NOT NULL,
  email_message_id BIGINT UNSIGNED NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_comm_provider_event (tenant_id, provider, provider_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. Governance audit trail ----------------------------------------------------
-- Append-only record of provider config changes, suppression add/release and
-- consent events, scoped per tenant.
CREATE TABLE IF NOT EXISTS tenant_comm_audit (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  actor_id   BIGINT UNSIGNED NULL,
  action     VARCHAR(40)  NOT NULL,
  channel    VARCHAR(20)  NULL,
  detail     JSON         NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_comm_audit (tenant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
