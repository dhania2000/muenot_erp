import "server-only"
import { query } from "@/lib/db"

/**
 * SPEC 118 — Client Portal · runtime schema self-heal.
 * ---------------------------------------------------------------------------
 * Follows the project convention (lib/tenant-service.ts, lib/session-store.ts):
 * every table is created with CREATE TABLE IF NOT EXISTS and converges existing
 * databases without a manual migration step. All portal tables carry BOTH a
 * `tenant_id` (registered in lib/tenant-tables.ts so the data-layer guard
 * enforces it) and a `client_id` (enforced by the store layer), giving the
 * two-axis tenant + client isolation the portal requires.
 */

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  // External login accounts. One portal user belongs to exactly one client
  // within exactly one tenant. Email is unique per tenant (a person may exist
  // as a portal user under different tenants with the same email).
  await query(`
    CREATE TABLE IF NOT EXISTS \`client_portal_users\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`client_id\` BIGINT UNSIGNED NOT NULL,
      \`email\` VARCHAR(190) NOT NULL,
      \`name\` VARCHAR(150) NOT NULL,
      \`password_hash\` VARCHAR(255) DEFAULT NULL,
      \`status\` ENUM('invited','active','disabled') NOT NULL DEFAULT 'invited',
      \`must_change_password\` TINYINT(1) NOT NULL DEFAULT 0,
      \`invite_token\` VARCHAR(80) DEFAULT NULL,
      \`invite_expires_at\` DATETIME DEFAULT NULL,
      \`last_login_at\` DATETIME DEFAULT NULL,
      \`failed_attempts\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`locked_until\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_portal_user_email\` (\`tenant_id\`, \`email\`),
      UNIQUE KEY \`uniq_portal_invite\` (\`invite_token\`),
      KEY \`idx_portal_user_client\` (\`tenant_id\`, \`client_id\`),
      KEY \`idx_portal_user_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Per-client resource access grants. Presence of a row (enabled=1) means the
  // client may see that resource in the portal. Scoped at the client level
  // because "CLIENTS can access permitted ..." (SPEC 118).
  await query(`
    CREATE TABLE IF NOT EXISTS \`client_portal_access\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`client_id\` BIGINT UNSIGNED NOT NULL,
      \`resource\` VARCHAR(30) NOT NULL,
      \`enabled\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_portal_access\` (\`tenant_id\`, \`client_id\`, \`resource\`),
      KEY \`idx_portal_access_client\` (\`tenant_id\`, \`client_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Curated read-only records shared with a client (quotes, orders, invoices,
  // payments, documents, projects). Published by internal staff.
  await query(`
    CREATE TABLE IF NOT EXISTS \`client_portal_items\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`client_id\` BIGINT UNSIGNED NOT NULL,
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
      KEY \`idx_portal_items_scope\` (\`tenant_id\`, \`client_id\`, \`resource\`),
      KEY \`idx_portal_items_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Client-raised support tickets.
  await query(`
    CREATE TABLE IF NOT EXISTS \`client_portal_tickets\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`client_id\` BIGINT UNSIGNED NOT NULL,
      \`ticket_number\` VARCHAR(40) NOT NULL,
      \`subject\` VARCHAR(200) NOT NULL,
      \`priority\` ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
      \`status\` ENUM('open','pending','resolved','closed') NOT NULL DEFAULT 'open',
      \`created_by_portal_user_id\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_portal_ticket_number\` (\`tenant_id\`, \`ticket_number\`),
      KEY \`idx_portal_tickets_scope\` (\`tenant_id\`, \`client_id\`),
      KEY \`idx_portal_tickets_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Messages on a ticket thread.
  await query(`
    CREATE TABLE IF NOT EXISTS \`client_portal_ticket_messages\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`client_id\` BIGINT UNSIGNED NOT NULL,
      \`ticket_id\` BIGINT UNSIGNED NOT NULL,
      \`author_type\` ENUM('client','staff') NOT NULL,
      \`author_name\` VARCHAR(150) NOT NULL,
      \`body\` TEXT NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_portal_ticket_msg\` (\`tenant_id\`, \`client_id\`, \`ticket_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Direct message thread between the client and their account team.
  await query(`
    CREATE TABLE IF NOT EXISTS \`client_portal_messages\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`client_id\` BIGINT UNSIGNED NOT NULL,
      \`author_type\` ENUM('client','staff') NOT NULL,
      \`author_name\` VARCHAR(150) NOT NULL,
      \`body\` TEXT NOT NULL,
      \`read_at\` DATETIME DEFAULT NULL,
      \`created_by_portal_user_id\` BIGINT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_portal_messages_scope\` (\`tenant_id\`, \`client_id\`),
      KEY \`idx_portal_messages_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

/** Ensure the portal schema exists. Cached per process; safe to call often. */
export async function ensurePortalSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}
