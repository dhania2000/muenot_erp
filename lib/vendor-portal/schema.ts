import "server-only"
import { query } from "@/lib/db"

/**
 * SPEC 119 — Vendor Portal · runtime schema self-heal.
 * ---------------------------------------------------------------------------
 * Follows the project convention: every table is created with
 * CREATE TABLE IF NOT EXISTS and converges existing databases without a manual
 * migration step. All vendor-portal tables carry BOTH a `tenant_id` (registered
 * in lib/tenant-tables.ts so the data-layer guard enforces it) and a
 * `vendor_id` (enforced by the store layer), giving the two-axis
 * tenant + vendor isolation the portal requires.
 */

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  // External login accounts. One portal user belongs to exactly one vendor
  // within exactly one tenant. Email is unique per tenant.
  await query(`
    CREATE TABLE IF NOT EXISTS \`vendor_portal_users\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`vendor_id\` BIGINT UNSIGNED NOT NULL,
      \`email\` VARCHAR(190) NOT NULL,
      \`name\` VARCHAR(150) NOT NULL,
      \`password_hash\` VARCHAR(255) DEFAULT NULL,
      \`status\` ENUM('invited','active','disabled') NOT NULL DEFAULT 'invited',
      \`must_change_password\` TINYINT(1) NOT NULL DEFAULT 0,
      \`last_login_at\` DATETIME DEFAULT NULL,
      \`failed_attempts\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`locked_until\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_vendor_portal_user_email\` (\`tenant_id\`, \`email\`),
      KEY \`idx_vendor_portal_user_vendor\` (\`tenant_id\`, \`vendor_id\`),
      KEY \`idx_vendor_portal_user_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Per-vendor resource access grants. Presence of a row (enabled=1) means the
  // vendor may see that resource in the portal.
  await query(`
    CREATE TABLE IF NOT EXISTS \`vendor_portal_access\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`vendor_id\` BIGINT UNSIGNED NOT NULL,
      \`resource\` VARCHAR(30) NOT NULL,
      \`enabled\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_vendor_portal_access\` (\`tenant_id\`, \`vendor_id\`, \`resource\`),
      KEY \`idx_vendor_portal_access_vendor\` (\`tenant_id\`, \`vendor_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Curated records shared with a vendor (POs, invoices, payments, documents,
  // compliance). Published by internal staff, or submitted by the vendor
  // (invoices) — distinguished by meta.source.
  await query(`
    CREATE TABLE IF NOT EXISTS \`vendor_portal_items\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`vendor_id\` BIGINT UNSIGNED NOT NULL,
      \`resource\` VARCHAR(30) NOT NULL,
      \`reference\` VARCHAR(80) DEFAULT NULL,
      \`title\` VARCHAR(200) NOT NULL,
      \`description\` TEXT DEFAULT NULL,
      \`status\` VARCHAR(40) DEFAULT NULL,
      \`amount\` DECIMAL(16,2) DEFAULT NULL,
      \`currency\` VARCHAR(10) DEFAULT NULL,
      \`issue_date\` DATE DEFAULT NULL,
      \`due_date\` DATE DEFAULT NULL,
      \`file_url\` VARCHAR(500) DEFAULT NULL,
      \`file_name\` VARCHAR(200) DEFAULT NULL,
      \`meta\` JSON DEFAULT NULL,
      \`created_by\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_vendor_portal_items_scope\` (\`tenant_id\`, \`vendor_id\`, \`resource\`),
      KEY \`idx_vendor_portal_items_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Direct message thread between the vendor and the accounts-payable team.
  await query(`
    CREATE TABLE IF NOT EXISTS \`vendor_portal_messages\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`vendor_id\` BIGINT UNSIGNED NOT NULL,
      \`author_type\` ENUM('vendor','staff') NOT NULL,
      \`author_name\` VARCHAR(150) NOT NULL,
      \`body\` TEXT NOT NULL,
      \`read_at\` DATETIME DEFAULT NULL,
      \`created_by_portal_user_id\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_vendor_portal_messages_scope\` (\`tenant_id\`, \`vendor_id\`),
      KEY \`idx_vendor_portal_messages_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

/** Ensure the vendor-portal schema exists. Cached per process; safe to call often. */
export async function ensureVendorPortalSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}
