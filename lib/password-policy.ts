import "server-only"
/**
 * Password policy: configuration, validation, reuse history and
 * lockout, actually enforced by the backend (not just described in the UI).
 * ---------------------------------------------------------------------------
 * Policy values live in the existing tenant-settings store (lib/tenant-settings
 * / lib/settings/server) under the `security.*` keys already surfaced in
 * Company Settings, so a tenant admin has exactly one place to change them.
 * This module adds the pieces that store data doesn't: password history
 * (to block reuse) and login lockout counters, plus the pure validators every
 * password-setting code path (register, change, admin reset, forgot-password
 * reset) must call.
 */
import { query } from "@/lib/db"
import { getBool, getNum } from "@/lib/settings/server"
import { hashPassword, verifyPassword } from "@/lib/password"

export type PasswordPolicy = {
  minLength: number
  requireCase: boolean
  requireNumber: boolean
  requireSymbol: boolean
  expiryDays: number
  reuseHistory: number
  maxLoginAttempts: number
  lockoutDurationMinutes: number
  tempPasswordExpiryHours: number
}

export async function getPasswordPolicy(): Promise<PasswordPolicy> {
  const [
    minLength,
    requireCase,
    requireNumber,
    requireSymbol,
    expiryDays,
    reuseHistory,
    maxLoginAttempts,
    lockoutDurationMinutes,
    tempPasswordExpiryHours,
  ] = await Promise.all([
    getNum("security.password_min_length", 8),
    getBool("security.password_require_case", true),
    getBool("security.password_require_number", true),
    getBool("security.password_require_symbol", false),
    getNum("security.password_expiry_days", 90),
    getNum("security.password_reuse_history", 5),
    getNum("security.max_login_attempts", 5),
    getNum("security.lockout_duration_minutes", 15),
    getNum("security.temp_password_expiry_hours", 24),
  ])
  return {
    minLength: Math.max(6, Math.floor(minLength) || 8),
    requireCase,
    requireNumber,
    requireSymbol,
    expiryDays: Math.max(0, Math.floor(expiryDays) || 0),
    reuseHistory: Math.max(0, Math.floor(reuseHistory) || 0),
    maxLoginAttempts: Math.max(1, Math.floor(maxLoginAttempts) || 5),
    lockoutDurationMinutes: Math.max(1, Math.floor(lockoutDurationMinutes) || 15),
    tempPasswordExpiryHours: Math.max(1, Math.floor(tempPasswordExpiryHours) || 24),
  }
}

/** Pure validation — no DB access, safe to call from any route. */
export function validatePasswordAgainstPolicy(password: string, policy: PasswordPolicy): string[] {
  const errors: string[] = []
  const value = String(password ?? "")
  if (value.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters`)
  }
  if (policy.requireCase && !(/[a-z]/.test(value) && /[A-Z]/.test(value))) {
    errors.push("Password must include both upper and lower case letters")
  }
  if (policy.requireNumber && !/[0-9]/.test(value)) {
    errors.push("Password must include at least one number")
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(value)) {
    errors.push("Password must include at least one symbol")
  }
  return errors
}

// ---------------------------------------------------------------------------
// Self-healing schema — lockout columns on `users` + append-only history
// ---------------------------------------------------------------------------
let ensured: Promise<void> | null = null

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function addColumn(table: string, column: string, def: string): Promise<void> {
  if (!(await columnExists(table, column))) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`)
  }
}

async function runEnsure(): Promise<void> {
  await addColumn("users", "failed_login_attempts", "SMALLINT UNSIGNED NOT NULL DEFAULT 0")
  await addColumn("users", "locked_until", "DATETIME DEFAULT NULL")
  await addColumn("users", "password_changed_at", "DATETIME DEFAULT NULL")

  await query(`
    CREATE TABLE IF NOT EXISTS \`user_password_history\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`password_hash\` VARCHAR(255) NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_password_history_user\` (\`user_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensurePasswordPolicySchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((error) => {
      ensured = null
      throw error
    })
  }
  return ensured
}

/** Rejects the password if it matches any of the user's last `reuseHistory` passwords. */
export async function isPasswordReused(userId: number, newPassword: string, reuseHistory: number): Promise<boolean> {
  if (reuseHistory <= 0) return false
  await ensurePasswordPolicySchema()
  const rows = await query<{ password_hash: string }[]>(
    `SELECT password_hash FROM user_password_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [userId, reuseHistory],
  )
  for (const row of rows) {
    if (await verifyPassword(newPassword, row.password_hash)) return true
  }
  return false
}

/** Records the new hash in history and stamps password_changed_at. Call right after updating users.password_hash. */
export async function recordPasswordChange(
  userId: number,
  passwordHash: string,
  tenantId?: number | null,
): Promise<void> {
  await ensurePasswordPolicySchema()
  await query(`UPDATE users SET password_changed_at = NOW(), failed_login_attempts = 0, locked_until = NULL WHERE id = ?`, [
    userId,
  ])
  await query(`INSERT INTO user_password_history (tenant_id, user_id, password_hash) VALUES (?,?,?)`, [
    tenantId ?? null,
    userId,
    passwordHash,
  ])
}

/** Validates + hashes a new password, enforcing both policy rules and reuse history. Throws on failure. */
export async function assertAndHashNewPassword(userId: number, newPassword: string): Promise<string> {
  const policy = await getPasswordPolicy()
  const errors = validatePasswordAgainstPolicy(newPassword, policy)
  if (errors.length) throw new Error(errors[0])
  if (await isPasswordReused(userId, newPassword, policy.reuseHistory)) {
    throw new Error(`New password cannot match any of your last ${policy.reuseHistory} passwords`)
  }
  return hashPassword(newPassword)
}

export type LockoutCheck = { locked: false } | { locked: true; retryAfterSeconds: number }

/** Whether the account is currently locked out from failed attempts. */
export async function checkLockout(userId: number): Promise<LockoutCheck> {
  await ensurePasswordPolicySchema()
  const rows = await query<{ locked_until: string | null }[]>(`SELECT locked_until FROM users WHERE id = ? LIMIT 1`, [
    userId,
  ])
  const lockedUntil = rows[0]?.locked_until ? new Date(rows[0].locked_until) : null
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    return { locked: true, retryAfterSeconds: Math.ceil((lockedUntil.getTime() - Date.now()) / 1000) }
  }
  return { locked: false }
}

/** Records a failed login attempt; locks the account once the policy threshold is reached. */
export async function recordFailedLogin(userId: number): Promise<void> {
  await ensurePasswordPolicySchema()
  const policy = await getPasswordPolicy()
  const rows = await query<{ failed_login_attempts: number }[]>(
    `SELECT failed_login_attempts FROM users WHERE id = ? LIMIT 1`,
    [userId],
  )
  const attempts = (rows[0]?.failed_login_attempts ?? 0) + 1
  if (attempts >= policy.maxLoginAttempts) {
    await query(
      `UPDATE users SET failed_login_attempts = ?, locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?`,
      [attempts, policy.lockoutDurationMinutes, userId],
    )
  } else {
    await query(`UPDATE users SET failed_login_attempts = ? WHERE id = ?`, [attempts, userId])
  }
}

/** Clears the lockout/attempt counters after a successful login. */
export async function recordSuccessfulLogin(userId: number): Promise<void> {
  await ensurePasswordPolicySchema()
  await query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?`, [userId])
}

/** Whether the user's current password has expired under the policy and must be changed. */
export async function isPasswordExpired(passwordChangedAt: string | Date | null, expiryDays: number): Promise<boolean> {
  if (!expiryDays || expiryDays <= 0 || !passwordChangedAt) return false
  const changed = new Date(passwordChangedAt)
  const ageDays = (Date.now() - changed.getTime()) / (1000 * 60 * 60 * 24)
  return ageDays >= expiryDays
}
