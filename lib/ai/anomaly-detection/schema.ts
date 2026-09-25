import "server-only"
/**
 * SPEC 20 (req #75) — self-healing schema for AI Anomaly Detection.
 * ---------------------------------------------------------------------------
 * Mirrors the deploy-time migration byte-for-byte so an install with no
 * migration step still converges. All three tables are tenant-owned (registered
 * in lib/tenant-tables.ts) and enforced by the fail-closed data-layer guard:
 * every read/write carries a tenant_id predicate.
 */

import { query } from "@/lib/db"

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ai_anomaly_alerts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT NOT NULL,
      signal VARCHAR(40) NOT NULL,
      category VARCHAR(20) NOT NULL,
      entity_type VARCHAR(60) NOT NULL,
      entity_id VARCHAR(120) NOT NULL,
      entity_label VARCHAR(255) NULL,
      severity VARCHAR(12) NOT NULL DEFAULT 'low',
      score DECIMAL(5,4) NOT NULL DEFAULT 0,
      method VARCHAR(12) NOT NULL DEFAULT 'rule',
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      title VARCHAR(255) NOT NULL,
      summary VARCHAR(1000) NULL,
      evidence_json JSON NULL,
      occurred_at DATETIME NULL,
      signature VARCHAR(64) NOT NULL,
      occurrence_count INT NOT NULL DEFAULT 1,
      first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      owner_id INT NULL,
      resolution_note VARCHAR(1000) NULL,
      reviewed_by INT NULL,
      reviewed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- Idempotent detection: the same anomaly (per day bucket) maps to one row.
      UNIQUE KEY uq_ai_anomaly_signature (tenant_id, signature),
      KEY idx_ai_anomaly_tenant_status (tenant_id, status),
      KEY idx_ai_anomaly_tenant_sev (tenant_id, severity),
      KEY idx_ai_anomaly_tenant_cat (tenant_id, category),
      KEY idx_ai_anomaly_owner (tenant_id, owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS ai_anomaly_alert_audit (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT NOT NULL,
      alert_id BIGINT UNSIGNED NOT NULL,
      action VARCHAR(40) NOT NULL,
      detail VARCHAR(1000) NULL,
      from_status VARCHAR(16) NULL,
      to_status VARCHAR(16) NULL,
      user_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ai_anomaly_audit_alert (tenant_id, alert_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS ai_anomaly_scans (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'running',
      window_days INT NOT NULL DEFAULT 90,
      categories VARCHAR(120) NULL,
      model_scoring TINYINT(1) NOT NULL DEFAULT 0,
      findings_count INT NOT NULL DEFAULT 0,
      created_count INT NOT NULL DEFAULT 0,
      deduped_count INT NOT NULL DEFAULT 0,
      error VARCHAR(1000) NULL,
      triggered_by INT NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME NULL,
      PRIMARY KEY (id),
      KEY idx_ai_anomaly_scan_tenant (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

export function ensureAnomalyDetectionSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}
