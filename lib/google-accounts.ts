import { query } from "@/lib/db"

/**
 * Per-user Google account storage. Each sales executive connects their own
 * Google account via OAuth; we persist their refresh token here so meetings
 * can be created in (and invitations sent from) their own calendar.
 */

let tableEnsured = false

export async function ensureGoogleAccountsTable() {
  if (tableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS \`sales_google_accounts\` (
      \`user_id\` INT UNSIGNED NOT NULL,
      \`google_email\` VARCHAR(190) DEFAULT NULL,
      \`refresh_token\` TEXT NOT NULL,
      \`scope\` TEXT DEFAULT NULL,
      \`connected_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`user_id\`),
      CONSTRAINT \`fk_google_accounts_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  tableEnsured = true
}

export type GoogleAccount = {
  user_id: number
  google_email: string | null
  refresh_token: string
  scope: string | null
}

export async function getGoogleAccount(userId: number): Promise<GoogleAccount | null> {
  await ensureGoogleAccountsTable()
  const rows = await query<GoogleAccount[]>(
    "SELECT user_id, google_email, refresh_token, scope FROM `sales_google_accounts` WHERE user_id = ? LIMIT 1",
    [userId],
  )
  return rows[0] ?? null
}

export async function saveGoogleAccount(
  userId: number,
  data: { refreshToken: string; email: string | null; scope: string | null },
) {
  await ensureGoogleAccountsTable()
  await query(
    `INSERT INTO \`sales_google_accounts\` (user_id, google_email, refresh_token, scope)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       google_email = VALUES(google_email),
       refresh_token = VALUES(refresh_token),
       scope = VALUES(scope)`,
    [userId, data.email, data.refreshToken, data.scope],
  )
}

export async function deleteGoogleAccount(userId: number) {
  await ensureGoogleAccountsTable()
  await query("DELETE FROM `sales_google_accounts` WHERE user_id = ?", [userId])
}
