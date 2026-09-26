import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

/**
 * Mirrors database/migrations/2027-02-12-spec41-comms-governance.sql so a fresh
 * environment self-heals. Every table is tenant-owned.
 */
async function createSchema() {
  await query(`CREATE TABLE IF NOT EXISTS tenant_comm_providers (
    tenant_id BIGINT UNSIGNED NOT NULL, channel VARCHAR(20) NOT NULL, provider VARCHAR(30) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1, credential_ref VARCHAR(120) NULL, settings_json JSON NULL,
    hourly_limit INT UNSIGNED NULL, daily_limit INT UNSIGNED NULL, version INT UNSIGNED NOT NULL DEFAULT 1,
    updated_by BIGINT UNSIGNED NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY(tenant_id, channel)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS tenant_comm_suppressions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id BIGINT UNSIGNED NOT NULL, channel VARCHAR(20) NOT NULL,
    address_hash CHAR(64) NOT NULL, address_masked VARCHAR(80) NOT NULL, reason VARCHAR(20) NOT NULL,
    hit_count INT UNSIGNED NOT NULL DEFAULT 1, source VARCHAR(40) NOT NULL, provider_event_id VARCHAR(190) NULL,
    created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, released_at DATETIME NULL, released_by BIGINT UNSIGNED NULL,
    PRIMARY KEY(id), UNIQUE KEY uq_comm_suppression(tenant_id, channel, address_hash, reason),
    KEY idx_comm_suppression_active(tenant_id, channel, released_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS tenant_comm_send_counters (
    tenant_id BIGINT UNSIGNED NOT NULL, channel VARCHAR(20) NOT NULL, window_kind VARCHAR(4) NOT NULL,
    window_start DATETIME NOT NULL, sent INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY(tenant_id, channel, window_kind, window_start)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS tenant_comm_provider_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id BIGINT UNSIGNED NOT NULL, provider VARCHAR(20) NOT NULL,
    provider_event_id VARCHAR(190) NOT NULL, event_type VARCHAR(20) NOT NULL, address_hash CHAR(64) NOT NULL,
    email_message_id BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(id), UNIQUE KEY uq_comm_provider_event(tenant_id, provider, provider_event_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS tenant_comm_audit (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, tenant_id BIGINT UNSIGNED NOT NULL, actor_id BIGINT UNSIGNED NULL,
    action VARCHAR(40) NOT NULL, channel VARCHAR(20) NULL, detail JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(id), KEY idx_comm_audit(tenant_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

export function ensureCommsGovernanceSchema() {
  if (!ensured) ensured = createSchema().catch((error) => { ensured = null; throw error })
  return ensured
}
