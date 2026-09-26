import "server-only"
import { query } from "@/lib/db"

/**
 * Self-healing schema for the risk & compliance snapshot cache (Spec43).
 *
 * The dashboard only OWNS this one table — every metric is aggregated from
 * existing subsystems at read time. The snapshot table exists purely to make
 * refreshes idempotent and to detect stale metrics (compare `computed_at` to
 * the request time). It never becomes a source of truth for the underlying
 * data. Mirrors database/migrations/2027-02-14-spec43-risk-compliance.sql.
 */
let ensured = false

export async function ensureRiskComplianceSchema(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS risk_compliance_snapshots (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       tenant_id INT UNSIGNED NOT NULL,
       scope_key VARCHAR(190) NOT NULL DEFAULT 'group',
       payload JSON NOT NULL,
       computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       computed_by INT UNSIGNED DEFAULT NULL,
       idempotency_key VARCHAR(100) DEFAULT NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_rc_snapshot_idem (tenant_id, idempotency_key),
       KEY idx_rc_snapshot_scope (tenant_id, scope_key, computed_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  )
  ensured = true
}

/** Test-only: reset the memoized "schema created" flag. */
export function __resetRiskComplianceSchemaFlag(): void {
  ensured = false
}
