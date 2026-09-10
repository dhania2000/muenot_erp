import { query } from "@/lib/db"

/**
 * Storage for connected social media accounts and the posts published from
 * them. Each account row holds the OAuth tokens we need to publish on behalf
 * of a company page or an individual employee. Tokens are stored the same way
 * the Google integration stores them (see lib/google-accounts.ts) to match the
 * existing codebase convention.
 */

export type SocialPlatform = "linkedin" | "x" | "facebook" | "instagram"
export type SocialAccountType = "company" | "personal"

let accountsTableEnsured = false
let postsTableEnsured = false

export async function ensureSocialAccountsTable() {
  if (accountsTableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_social_accounts\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`platform\` VARCHAR(32) NOT NULL,
      \`account_type\` VARCHAR(16) NOT NULL DEFAULT 'company',
      \`connected_by_user_id\` INT UNSIGNED DEFAULT NULL,
      \`external_id\` VARCHAR(191) DEFAULT NULL,
      \`handle\` VARCHAR(191) NOT NULL,
      \`display_name\` VARCHAR(191) DEFAULT NULL,
      \`owner_name\` VARCHAR(191) DEFAULT NULL,
      \`followers\` INT DEFAULT NULL,
      \`access_token\` TEXT DEFAULT NULL,
      \`refresh_token\` TEXT DEFAULT NULL,
      \`token_expires_at\` DATETIME DEFAULT NULL,
      \`page_id\` VARCHAR(191) DEFAULT NULL,
      \`scope\` TEXT DEFAULT NULL,
      \`connected_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_platform_external\` (\`platform\`, \`external_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  accountsTableEnsured = true
}

export async function ensureSocialPostsTable() {
  if (postsTableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS \`marketing_social_posts\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(255) NOT NULL,
      \`content\` TEXT NOT NULL,
      \`brand\` VARCHAR(191) DEFAULT NULL,
      \`image_url\` TEXT DEFAULT NULL,
      \`targets\` JSON DEFAULT NULL,
      \`account_ids\` JSON DEFAULT NULL,
      \`status\` VARCHAR(20) NOT NULL DEFAULT 'Draft',
      \`folder\` VARCHAR(120) NOT NULL DEFAULT 'Unclassified',
      \`results\` JSON DEFAULT NULL,
      \`created_by_user_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`published_at\` DATETIME DEFAULT NULL,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  postsTableEnsured = true
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export type SocialAccountRow = {
  id: number
  platform: SocialPlatform
  account_type: SocialAccountType
  connected_by_user_id: number | null
  external_id: string | null
  handle: string
  display_name: string | null
  owner_name: string | null
  followers: number | null
  access_token: string | null
  refresh_token: string | null
  token_expires_at: string | null
  page_id: string | null
  scope: string | null
  connected_at: string
  updated_at: string
}

/** Public shape returned to the client — never exposes tokens. */
export type SocialAccountPublic = {
  id: number
  platform: SocialPlatform
  type: SocialAccountType
  handle: string
  displayName: string | null
  owner: string | null
  followers: number | null
  connectedAt: string
}

export function toPublicAccount(row: SocialAccountRow): SocialAccountPublic {
  return {
    id: row.id,
    platform: row.platform,
    type: row.account_type,
    handle: row.handle,
    displayName: row.display_name,
    owner: row.owner_name,
    followers: row.followers,
    connectedAt: row.connected_at,
  }
}

export async function listSocialAccounts(): Promise<SocialAccountRow[]> {
  await ensureSocialAccountsTable()
  return query<SocialAccountRow[]>(
    "SELECT * FROM `marketing_social_accounts` ORDER BY platform, connected_at",
  )
}

export async function getSocialAccountById(id: number): Promise<SocialAccountRow | null> {
  await ensureSocialAccountsTable()
  const rows = await query<SocialAccountRow[]>(
    "SELECT * FROM `marketing_social_accounts` WHERE id = ? LIMIT 1",
    [id],
  )
  return rows[0] ?? null
}

export type UpsertSocialAccount = {
  platform: SocialPlatform
  accountType: SocialAccountType
  connectedByUserId: number | null
  externalId: string
  handle: string
  displayName: string | null
  ownerName: string | null
  followers: number | null
  accessToken: string
  refreshToken: string | null
  tokenExpiresAt: string | null
  pageId: string | null
  scope: string | null
}

export async function upsertSocialAccount(data: UpsertSocialAccount) {
  await ensureSocialAccountsTable()
  await query(
    `INSERT INTO \`marketing_social_accounts\`
      (platform, account_type, connected_by_user_id, external_id, handle, display_name,
       owner_name, followers, access_token, refresh_token, token_expires_at, page_id, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       account_type = VALUES(account_type),
       connected_by_user_id = VALUES(connected_by_user_id),
       handle = VALUES(handle),
       display_name = VALUES(display_name),
       owner_name = VALUES(owner_name),
       followers = VALUES(followers),
       access_token = VALUES(access_token),
       refresh_token = VALUES(refresh_token),
       token_expires_at = VALUES(token_expires_at),
       page_id = VALUES(page_id),
       scope = VALUES(scope)`,
    [
      data.platform,
      data.accountType,
      data.connectedByUserId,
      data.externalId,
      data.handle,
      data.displayName,
      data.ownerName,
      data.followers,
      data.accessToken,
      data.refreshToken,
      data.tokenExpiresAt,
      data.pageId,
      data.scope,
    ],
  )
}

export async function deleteSocialAccount(id: number) {
  await ensureSocialAccountsTable()
  await query("DELETE FROM `marketing_social_accounts` WHERE id = ?", [id])
}

/* ------------------------------------------------------------------ */
/* Posts                                                               */
/* ------------------------------------------------------------------ */

export type SocialPostStatus = "Draft" | "Scheduled" | "Publishing" | "Published" | "Failed"

export type SocialPostRow = {
  id: number
  name: string
  content: string
  brand: string | null
  image_url: string | null
  targets: string[] | null
  account_ids: number[] | null
  status: SocialPostStatus
  folder: string
  results: unknown | null
  created_by_user_id: number | null
  created_at: string
  published_at: string | null
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

export type SocialPostPublic = {
  id: number
  name: string
  content: string
  brand: string | null
  image?: string
  targets: SocialPlatform[]
  accountIds: number[]
  status: SocialPostStatus
  folder: string
  results: unknown | null
  createdAt: string
  publishedAt: string | null
}

export function toPublicPost(row: SocialPostRow): SocialPostPublic {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    brand: row.brand,
    image: row.image_url ?? undefined,
    targets: parseJsonColumn<SocialPlatform[]>(row.targets, []),
    accountIds: parseJsonColumn<number[]>(row.account_ids, []),
    status: row.status,
    folder: row.folder,
    results: parseJsonColumn<unknown>(row.results, null),
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }
}

export async function listSocialPosts(): Promise<SocialPostRow[]> {
  await ensureSocialPostsTable()
  return query<SocialPostRow[]>(
    "SELECT * FROM `marketing_social_posts` ORDER BY created_at DESC",
  )
}

export async function getSocialPostById(id: number): Promise<SocialPostRow | null> {
  await ensureSocialPostsTable()
  const rows = await query<SocialPostRow[]>(
    "SELECT * FROM `marketing_social_posts` WHERE id = ? LIMIT 1",
    [id],
  )
  return rows[0] ?? null
}

export type CreateSocialPost = {
  name: string
  content: string
  brand: string | null
  imageUrl: string | null
  targets: SocialPlatform[]
  accountIds: number[]
  status: SocialPostStatus
  folder: string
  createdByUserId: number | null
}

export async function createSocialPost(data: CreateSocialPost): Promise<number> {
  await ensureSocialPostsTable()
  const result = await query<{ insertId: number }>(
    `INSERT INTO \`marketing_social_posts\`
      (name, content, brand, image_url, targets, account_ids, status, folder, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name,
      data.content,
      data.brand,
      data.imageUrl,
      JSON.stringify(data.targets),
      JSON.stringify(data.accountIds),
      data.status,
      data.folder,
      data.createdByUserId,
    ],
  )
  return result.insertId
}

export async function updateSocialPostStatus(
  id: number,
  status: SocialPostStatus,
  opts: { results?: unknown; publishedAt?: string | null } = {},
) {
  await ensureSocialPostsTable()
  await query(
    `UPDATE \`marketing_social_posts\`
     SET status = ?, results = ?, published_at = ?
     WHERE id = ?`,
    [
      status,
      opts.results !== undefined ? JSON.stringify(opts.results) : null,
      opts.publishedAt ?? null,
      id,
    ],
  )
}

export async function deleteSocialPost(id: number) {
  await ensureSocialPostsTable()
  await query("DELETE FROM `marketing_social_posts` WHERE id = ?", [id])
}
