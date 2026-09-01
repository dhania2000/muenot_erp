import crypto from "crypto"
import { query } from "@/lib/db"

const RESET_TOKEN_TTL_MINUTES = 60

let tableEnsured = false

/**
 * Self-healing: creates the password_reset_tokens table if it doesn't exist
 * yet, so the feature works even before the SQL migration has been run
 * manually. Safe to call on every request (short-circuits after first success).
 */
export async function ensurePasswordResetTable() {
  if (tableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_reset_token_hash (token_hash),
      KEY idx_reset_tokens_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  tableEnsured = true
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex")
}

/**
 * Creates a fresh reset token for the given user. Invalidates any previous
 * outstanding tokens for that user so only the latest link works.
 */
export async function createResetToken(userId: number) {
  await ensurePasswordResetTable()
  await query("DELETE FROM password_reset_tokens WHERE user_id = ?", [userId])

  const token = crypto.randomBytes(32).toString("hex")
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000)

  await query(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [userId, tokenHash, expiresAt],
  )

  return token
}

/** Looks up a still-valid (unused, unexpired) token and returns its user id, or null. */
export async function verifyResetToken(token: string): Promise<{ tokenId: number; userId: number } | null> {
  await ensurePasswordResetTable()
  const tokenHash = hashToken(token)
  const rows = await query<any[]>(
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
    [tokenHash],
  )
  const row = rows[0]
  if (!row) return null
  return { tokenId: row.id, userId: row.user_id }
}

export async function consumeResetToken(tokenId: number) {
  await query("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?", [tokenId])
}
