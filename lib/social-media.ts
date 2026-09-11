import { query } from "@/lib/db"

/**
 * Stores uploaded post images directly in MySQL so they can be served from a
 * public, stable https URL. Instagram's Graph API does not accept raw image
 * bytes or in-browser data URLs — it fetches the image itself from a public
 * URL. Keeping the bytes here (instead of an external blob store) lets the app
 * mint that URL from its own domain via GET /api/marketing/social/media/[id].
 */

let mediaTableEnsured = false

export async function ensureSocialMediaTable() {
  if (mediaTableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_social_media\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`content_type\` VARCHAR(100) NOT NULL,
      \`byte_size\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`data\` LONGBLOB NOT NULL,
      \`uploaded_by_user_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  mediaTableEnsured = true
}

export async function insertSocialMedia(
  data: Buffer,
  contentType: string,
  userId?: number | null,
): Promise<number> {
  await ensureSocialMediaTable()
  const res: any = await query(
    "INSERT INTO `marketing_social_media` (`content_type`, `byte_size`, `data`, `uploaded_by_user_id`) VALUES (?, ?, ?, ?)",
    [contentType, data.length, data, userId ?? null],
  )
  return res.insertId as number
}

export type SocialMediaRow = { id: number; content_type: string; data: Buffer }

export async function getSocialMedia(id: number): Promise<SocialMediaRow | null> {
  await ensureSocialMediaTable()
  const rows = await query<SocialMediaRow[]>(
    "SELECT `id`, `content_type`, `data` FROM `marketing_social_media` WHERE id = ? LIMIT 1",
    [id],
  )
  return rows[0] ?? null
}
