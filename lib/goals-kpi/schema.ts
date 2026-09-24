import "server-only"
import { query } from "@/lib/db"

/**
 * SPEC 135 — Goal / KPI Engine · runtime schema self-heal.
 * ---------------------------------------------------------------------------
 * Follows the project convention: every table is created with
 * CREATE TABLE IF NOT EXISTS and converges existing databases without a manual
 * migration step. Both tables carry a `tenant_id` (registered in
 * lib/tenant-tables.ts so the data-layer guard enforces isolation).
 */

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  // KPI / goal definitions. One row = one measurable goal at a given scope.
  await query(`
    CREATE TABLE IF NOT EXISTS \`kpi_goals\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(200) NOT NULL,
      \`description\` TEXT DEFAULT NULL,
      \`scope\` ENUM('individual','team','department','company','project') NOT NULL,
      \`scope_ref_id\` VARCHAR(64) DEFAULT NULL,
      \`scope_ref_label\` VARCHAR(200) DEFAULT NULL,
      \`unit\` VARCHAR(30) DEFAULT NULL,
      \`direction\` ENUM('increase','decrease','maintain') NOT NULL DEFAULT 'increase',
      \`target_value\` DECIMAL(18,4) NOT NULL DEFAULT 0,
      \`actual_value\` DECIMAL(18,4) NOT NULL DEFAULT 0,
      \`weight\` DECIMAL(6,2) NOT NULL DEFAULT 1,
      \`period_type\` ENUM('monthly','quarterly','annual','custom') NOT NULL DEFAULT 'monthly',
      \`period_start\` DATE DEFAULT NULL,
      \`period_end\` DATE DEFAULT NULL,
      \`lifecycle\` ENUM('active','archived') NOT NULL DEFAULT 'active',
      \`created_by\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_kpi_goals_scope\` (\`tenant_id\`, \`scope\`),
      KEY \`idx_kpi_goals_lifecycle\` (\`tenant_id\`, \`lifecycle\`),
      KEY \`idx_kpi_goals_subject\` (\`tenant_id\`, \`scope\`, \`scope_ref_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Append-only progress check-ins. Each check-in records a new actual value
  // and (optionally) a note; the parent goal's actual_value mirrors the latest.
  await query(`
    CREATE TABLE IF NOT EXISTS \`kpi_checkins\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`kpi_id\` BIGINT UNSIGNED NOT NULL,
      \`actual_value\` DECIMAL(18,4) NOT NULL,
      \`note\` TEXT DEFAULT NULL,
      \`created_by\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_kpi_checkins_goal\` (\`tenant_id\`, \`kpi_id\`),
      KEY \`idx_kpi_checkins_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

/** Ensure the Goals/KPI schema exists. Cached per process; safe to call often. */
export async function ensureGoalsKpiSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}
