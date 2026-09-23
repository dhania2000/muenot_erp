import "server-only"
import { createHash } from "node:crypto"
import type { RowDataPacket } from "mysql2"
import { pool, query } from "@/lib/db"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { ANDROID, parseReleaseInput, ReleaseValidationError, SHOPKEEPER_APP, type ReleaseInput } from "@/lib/mobile-app-release-core"

type Row = RowDataPacket & {
  id: number; application: string; platform: string; version_name: string; version_code: number;
  minimum_supported_version_code: number; apk_url: string | null; apk_size: number | null;
  apk_sha256: string | null; release_notes: string | string[]; force_update: number;
  status: "draft" | "published"; published_at: string | null;
  created_by: number | null; created_by_email?: string | null; updated_by: number | null; created_at: string; updated_at: string
}
export type Release = ReturnType<typeof mapRow>
export type ReleaseActor = { userId: number; email: string }

let ensured: Promise<void> | undefined
export function ensureMobileReleaseSchema(): Promise<void> {
  return ensured ??= query(`CREATE TABLE IF NOT EXISTS mobile_app_releases (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    application VARCHAR(64) NOT NULL, platform VARCHAR(24) NOT NULL,
    version_name VARCHAR(64) NOT NULL, version_code INT UNSIGNED NOT NULL,
    minimum_supported_version_code INT UNSIGNED NOT NULL,
    apk_url VARCHAR(2048) NULL, apk_url_hash CHAR(64) NULL, apk_size BIGINT UNSIGNED NULL, apk_sha256 CHAR(64) NULL,
    release_notes JSON NOT NULL, force_update TINYINT(1) NOT NULL DEFAULT 0,
    status ENUM('draft','published') NOT NULL DEFAULT 'draft', published_at DATETIME NULL,
    created_by INT UNSIGNED NULL, updated_by INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uq_mobile_release_version (application,platform,version_code),
    UNIQUE KEY uq_mobile_release_apk_url_hash (apk_url_hash),
    KEY idx_mobile_release_latest (application,platform,status,version_code),
    CONSTRAINT fk_mobile_release_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_mobile_release_editor FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT ck_mobile_release_codes CHECK (version_code > 0 AND minimum_supported_version_code > 0 AND minimum_supported_version_code <= version_code),
    CONSTRAINT ck_mobile_release_published CHECK (status <> 'published' OR (apk_url IS NOT NULL AND apk_size > 0 AND apk_sha256 IS NOT NULL AND published_at IS NOT NULL))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(() => {}).catch(error => { ensured = undefined; throw error })
}

function mapRow(row: Row) {
  let notes: string[] = []
  try { const value = typeof row.release_notes === "string" ? JSON.parse(row.release_notes) : row.release_notes; if (Array.isArray(value)) notes = value.filter((item): item is string => typeof item === "string") } catch { /* legacy malformed JSON is not public */ }
  return { id: Number(row.id), application: row.application, platform: row.platform, versionName: row.version_name,
    versionCode: Number(row.version_code), minimumVersionCode: Number(row.minimum_supported_version_code),
    apkUrl: row.apk_url, apkSize: row.apk_size == null ? null : Number(row.apk_size), apkSha256: row.apk_sha256,
    releaseNotes: notes, forceUpdate: Boolean(row.force_update), status: row.status,
    publishedAt: row.published_at, createdBy: row.created_by, createdByEmail: row.created_by_email ?? null, updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at }
}
function dbError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") throw new ReleaseValidationError("Version code or APK URL already exists.", 409)
  throw error
}
function metadata(value: ReleaseInput) {
  return [value.application, value.platform, value.versionName, value.versionCode, value.minimumVersionCode,
    value.apkUrl, value.apkUrl ? createHash("sha256").update(value.apkUrl).digest("hex") : null,
    value.apkSize, value.apkSha256, JSON.stringify(value.releaseNotes), value.forceUpdate ? 1 : 0]
}
const allowedHosts = () => process.env.MOBILE_APK_ALLOWED_HOSTS || ""

export async function listReleases(): Promise<Release[]> {
  await ensureMobileReleaseSchema()
  const rows = await query<Row[]>("SELECT r.*, u.email AS created_by_email FROM mobile_app_releases r LEFT JOIN users u ON u.id=r.created_by ORDER BY r.created_at DESC, r.id DESC LIMIT 200")
  return rows.map(mapRow)
}
export async function getRelease(id: number): Promise<Release | null> {
  await ensureMobileReleaseSchema()
  const rows = await query<Row[]>("SELECT r.*, u.email AS created_by_email FROM mobile_app_releases r LEFT JOIN users u ON u.id=r.created_by WHERE r.id=? LIMIT 1", [id])
  return rows[0] ? mapRow(rows[0]) : null
}
export async function createRelease(input: unknown, actor: ReleaseActor): Promise<Release> {
  const data = parseReleaseInput(input, { allowedHosts: allowedHosts() })
  await ensureMobileReleaseSchema()
  try {
    const result = await query<{ insertId: number }>(`INSERT INTO mobile_app_releases
      (application,platform,version_name,version_code,minimum_supported_version_code,apk_url,apk_url_hash,apk_size,apk_sha256,release_notes,force_update,created_by,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...metadata(data), actor.userId, actor.userId])
    const release = await getRelease(result.insertId)
    if (!release) throw new Error("Release creation failed")
    await recordPlatformAudit({ actorUserId: actor.userId, actorEmail: actor.email, action: "mobile_release_created", detail: { releaseId: release.id, versionCode: release.versionCode } })
    return release
  } catch (error) { dbError(error) }
}
export async function editDraft(id: number, input: unknown, actor: ReleaseActor): Promise<Release> {
  const data = parseReleaseInput(input, { allowedHosts: allowedHosts() })
  await ensureMobileReleaseSchema()
  const conn = await pool.getConnection()
  let changed: string[] = []
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<Row[]>("SELECT * FROM mobile_app_releases WHERE id=? FOR UPDATE", [id])
    const old = rows[0]
    if (!old) throw new ReleaseValidationError("Release not found.", 404)
    if (old.status !== "draft" || old.published_at) throw new ReleaseValidationError("A release that has ever been published is immutable.", 409)
    const before = mapRow(old)
    changed = (Object.keys(data) as (keyof ReleaseInput)[]).filter(key => JSON.stringify(before[key]) !== JSON.stringify(data[key]))
    await conn.query(`UPDATE mobile_app_releases SET application=?,platform=?,version_name=?,version_code=?,minimum_supported_version_code=?,apk_url=?,apk_url_hash=?,apk_size=?,apk_sha256=?,release_notes=?,force_update=?,updated_by=? WHERE id=?`, [...metadata(data), actor.userId, id])
    await conn.commit()
  } catch (error) { await conn.rollback().catch(() => {}); dbError(error) } finally { conn.release() }
  await recordPlatformAudit({ actorUserId: actor.userId, actorEmail: actor.email, action: "mobile_release_edited", detail: { releaseId: id, changedFields: changed } })
  for (const [field, action] of [["forceUpdate", "mobile_release_force_policy_changed"], ["minimumVersionCode", "mobile_release_minimum_version_changed"], ["apkUrl", "mobile_release_apk_metadata_changed"], ["apkSize", "mobile_release_apk_metadata_changed"], ["apkSha256", "mobile_release_apk_metadata_changed"]] as const) {
    if (changed.includes(field)) await recordPlatformAudit({ actorUserId: actor.userId, actorEmail: actor.email, action, detail: { releaseId: id, field } })
  }
  return (await getRelease(id))!
}
export async function setReleasePublished(id: number, publish: boolean, actor: ReleaseActor): Promise<Release> {
  await ensureMobileReleaseSchema()
  const conn = await pool.getConnection()
  let changed = false
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<Row[]>("SELECT * FROM mobile_app_releases WHERE id=? FOR UPDATE", [id])
    const row = rows[0]
    if (!row) throw new ReleaseValidationError("Release not found.", 404)
    if ((row.status === "published") !== publish) {
      if (publish) parseReleaseInput(mapRow(row), { publish: true, allowedHosts: allowedHosts() })
      await conn.query("UPDATE mobile_app_releases SET status=?, published_at=IF(?='published',COALESCE(published_at,UTC_TIMESTAMP()),published_at),updated_by=? WHERE id=?", [publish ? "published" : "draft", publish ? "published" : "draft", actor.userId, id])
      changed = true
    }
    await conn.commit()
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
  if (changed) await recordPlatformAudit({ actorUserId: actor.userId, actorEmail: actor.email, action: publish ? "mobile_release_published" : "mobile_release_unpublished", detail: { releaseId: id } })
  return (await getRelease(id))!
}

export async function latestPublicRelease() {
  await ensureMobileReleaseSchema()
  const rows = await query<Row[]>("SELECT * FROM mobile_app_releases WHERE application=? AND platform=? AND status='published' ORDER BY version_code DESC LIMIT 50", [SHOPKEEPER_APP, ANDROID])
  for (const row of rows) {
    const release = mapRow(row)
    try {
      if (!release.publishedAt) continue
      parseReleaseInput(release, { publish: true, allowedHosts: allowedHosts() })
      const publishedAt = new Date(`${release.publishedAt.replace(" ", "T")}Z`).toISOString()
      return { platform: release.platform, latestVersion: release.versionName, latestVersionCode: release.versionCode,
        minimumVersionCode: release.minimumVersionCode, forceUpdate: release.forceUpdate,
        apkUrl: release.apkUrl!, apkSize: release.apkSize!, apkSha256: release.apkSha256!,
        releaseNotes: release.releaseNotes, publishedAt }
    } catch { /* fail closed on malformed legacy rows */ }
  }
  return null
}
