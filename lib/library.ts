import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { userHasFeature } from "@/lib/permissions"
import type { SessionPayload } from "@/lib/auth"

/**
 * Marketing Library — central Digital Asset Management (DAM) data layer.
 *
 * The Library is the company's single source of truth for reusable marketing
 * assets. Other modules (Planner, Campaigns, Email, WhatsApp, Journeys, Legal,
 * Knowledge Base, ...) REFERENCE assets by `asset_id` instead of duplicating
 * the binary. Raw Blob URLs are never sent to the browser — downloads/previews
 * go through the authorized proxy route.
 *
 * Tables (created lazily, mirroring the Knowledge Base module's approach):
 *   marketing_library          — asset master (points at the current version)
 *   marketing_library_versions — every uploaded version, preserved forever
 *   marketing_library_folders  — nested folder tree, optional RBAC restriction
 *   marketing_library_usage    — references from other modules
 *   marketing_library_audit    — full activity trail
 */

export const LIBRARY_FEATURE = "marketing.library"

// ---------------------------------------------------------------------------
// Configurable vocabularies (Phase 4/7/27) — seeded, NOT hard-locked. Callers
// may store any string; these drive UI suggestions and defaults.
// ---------------------------------------------------------------------------
export const ASSET_TYPES = [
  "Image",
  "Document",
  "Video",
  "Audio",
  "PDF",
  "Presentation",
  "Spreadsheet",
  "Email Template",
  "Landing Page",
  "Logo",
  "Brand Asset",
  "Creative",
  "Brochure",
  "Case Study",
  "Whitepaper",
  "Social Creative",
  "Other",
] as const

export const ASSET_CATEGORIES = [
  "Brand",
  "Social Media",
  "Email",
  "Website",
  "Campaigns",
  "Sales",
  "Recruitment",
  "Events",
  "Corporate",
  "Documents",
  "Presentations",
  "Video",
  "Design",
  "Other",
] as const

export const ASSET_STATUSES = ["Draft", "Active", "Archived", "Expired", "Restricted"] as const
export type AssetStatus = (typeof ASSET_STATUSES)[number]

// Modules that may reference a Library asset (Phase 46).
export const USAGE_MODULES = [
  "planner",
  "campaign",
  "email",
  "whatsapp",
  "journey",
  "lead_generation",
  "website",
  "legal",
  "knowledge_base",
  "other",
] as const
export type UsageModule = (typeof USAGE_MODULES)[number]

// ---------------------------------------------------------------------------
// Upload validation (Phase 5/6). Extension allow-list + size cap + a light
// magic-byte sniff so a renamed executable can't masquerade as an image.
// ---------------------------------------------------------------------------
export const LIBRARY_MAX_BYTES = 200 * 1024 * 1024 // 200 MB
export const DEFAULT_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB (matches existing UI)

/** extension -> { mime category, canonical asset type suggestion } */
const EXT_MAP: Record<string, { mime: string; type: (typeof ASSET_TYPES)[number] }> = {
  // images
  png: { mime: "image/png", type: "Image" },
  jpg: { mime: "image/jpeg", type: "Image" },
  jpeg: { mime: "image/jpeg", type: "Image" },
  gif: { mime: "image/gif", type: "Image" },
  webp: { mime: "image/webp", type: "Image" },
  svg: { mime: "image/svg+xml", type: "Image" },
  bmp: { mime: "image/bmp", type: "Image" },
  ico: { mime: "image/x-icon", type: "Image" },
  // video
  mp4: { mime: "video/mp4", type: "Video" },
  webm: { mime: "video/webm", type: "Video" },
  mov: { mime: "video/quicktime", type: "Video" },
  // audio
  mp3: { mime: "audio/mpeg", type: "Audio" },
  wav: { mime: "audio/wav", type: "Audio" },
  ogg: { mime: "audio/ogg", type: "Audio" },
  // documents
  pdf: { mime: "application/pdf", type: "PDF" },
  doc: { mime: "application/msword", type: "Document" },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    type: "Document",
  },
  txt: { mime: "text/plain", type: "Document" },
  rtf: { mime: "application/rtf", type: "Document" },
  ppt: { mime: "application/vnd.ms-powerpoint", type: "Presentation" },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    type: "Presentation",
  },
  xls: { mime: "application/vnd.ms-excel", type: "Spreadsheet" },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    type: "Spreadsheet",
  },
  csv: { mime: "text/csv", type: "Spreadsheet" },
  // archives / design
  zip: { mime: "application/zip", type: "Other" },
}

export const LIBRARY_ALLOWED_EXT = Object.keys(EXT_MAP)

export function extensionOf(fileName: string): string {
  return (fileName.split(".").pop() || "").toLowerCase()
}

/** Suggests an asset type from the file name — callers may override. */
export function suggestAssetType(fileName: string): (typeof ASSET_TYPES)[number] {
  const ext = extensionOf(fileName)
  return EXT_MAP[ext]?.type ?? "Other"
}

export function categoryOf(fileName: string): "image" | "video" | "audio" | "pdf" | "document" | "other" {
  const t = suggestAssetType(fileName)
  if (t === "Image") return "image"
  if (t === "Video") return "video"
  if (t === "Audio") return "audio"
  if (t === "PDF") return "pdf"
  if (t === "Other") return "other"
  return "document"
}

/**
 * Content validation (Phase 5). Confirms the extension is allowed and — for the
 * formats with a stable signature — that the file's leading bytes match, so a
 * disguised file is rejected instead of trusted by extension alone.
 */
export function validateFile(fileName: string, size: number, head: Uint8Array): { ok: true } | { ok: false; error: string } {
  const ext = extensionOf(fileName)
  if (!ext) return { ok: false, error: "File has no extension" }
  if (!EXT_MAP[ext]) return { ok: false, error: `File type .${ext} is not allowed` }
  if (size <= 0) return { ok: false, error: "File is empty" }
  if (size > LIBRARY_MAX_BYTES)
    return { ok: false, error: `File exceeds ${Math.round(LIBRARY_MAX_BYTES / 1024 / 1024)} MB limit` }

  const startsWith = (...sig: number[]) => sig.every((b, i) => head[i] === b)
  const magicOk = (() => {
    switch (ext) {
      case "png":
        return startsWith(0x89, 0x50, 0x4e, 0x47)
      case "jpg":
      case "jpeg":
        return startsWith(0xff, 0xd8, 0xff)
      case "gif":
        return startsWith(0x47, 0x49, 0x46, 0x38)
      case "pdf":
        return startsWith(0x25, 0x50, 0x44, 0x46) // %PDF
      case "zip":
      case "docx":
      case "xlsx":
      case "pptx":
        return startsWith(0x50, 0x4b, 0x03, 0x04) // PK.. (OOXML is zip)
      case "mp4":
      case "mov":
        // ...ftyp at offset 4
        return head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
      default:
        return true // formats without a reliable signature we don't hard-block
    }
  })()
  if (!magicOk) return { ok: false, error: "File content does not match its extension" }
  return { ok: true }
}

export function mimeForExtension(fileName: string): string {
  return EXT_MAP[extensionOf(fileName)]?.mime ?? "application/octet-stream"
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
export async function canUseLibrary(session: SessionPayload | null): Promise<boolean> {
  if (!session) return false
  return userHasFeature(session.userId, session.role, LIBRARY_FEATURE)
}

/** Manage = create/update/version/delete. Admins always; feature grant otherwise. */
export async function canManageLibrary(session: SessionPayload | null): Promise<boolean> {
  if (!session) return false
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, LIBRARY_FEATURE)
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
let schemaReady: Promise<void> | null = null

export function ensureLibrarySchema(): Promise<void> {
  if (!schemaReady) schemaReady = createSchema()
  return schemaReady
}

async function createSchema() {
  await query(`CREATE TABLE IF NOT EXISTS marketing_library_folders (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    parent_id BIGINT NULL,
    path VARCHAR(512) NOT NULL DEFAULT '',
    restricted TINYINT(1) NOT NULL DEFAULT 0,
    allowed_roles JSON NULL,
    created_by INT NULL,
    created_by_name VARCHAR(160) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_lib_folder_parent (parent_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS marketing_library (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    asset_id VARCHAR(32) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    asset_type VARCHAR(64) NOT NULL DEFAULT 'Other',
    category VARCHAR(64) NULL,
    subcategory VARCHAR(64) NULL,
    description TEXT NULL,
    tags JSON NULL,
    folder_id BIGINT NULL,
    current_version INT NOT NULL DEFAULT 1,
    status VARCHAR(24) NOT NULL DEFAULT 'Active',
    owner_employee_id VARCHAR(32) NULL,
    owner_name VARCHAR(160) NULL,
    department VARCHAR(120) NULL,
    file_size BIGINT NOT NULL DEFAULT 0,
    file_type VARCHAR(160) NULL,
    storage_url TEXT NULL,
    preview_url TEXT NULL,
    content_hash CHAR(64) NULL,
    width INT NULL,
    height INT NULL,
    duration_seconds INT NULL,
    page_count INT NULL,
    usage_count INT NOT NULL DEFAULT 0,
    expiry_date DATE NULL,
    expiry_notified TINYINT(1) NOT NULL DEFAULT 0,
    usage_rights VARCHAR(255) NULL,
    copyright VARCHAR(255) NULL,
    license VARCHAR(255) NULL,
    attribution VARCHAR(255) NULL,
    restrictions TEXT NULL,
    license_expiry DATE NULL,
    source VARCHAR(24) NOT NULL DEFAULT 'upload',
    external_ref VARCHAR(64) NULL,
    created_by INT NULL,
    created_by_name VARCHAR(160) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_lib_status (status),
    INDEX idx_lib_type (asset_type),
    INDEX idx_lib_category (category),
    INDEX idx_lib_folder (folder_id),
    INDEX idx_lib_hash (content_hash),
    INDEX idx_lib_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS marketing_library_versions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    library_id BIGINT NOT NULL,
    version INT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(160) NULL,
    file_size BIGINT NOT NULL DEFAULT 0,
    storage_url TEXT NULL,
    content_hash CHAR(64) NULL,
    width INT NULL,
    height INT NULL,
    duration_seconds INT NULL,
    page_count INT NULL,
    change_note VARCHAR(500) NULL,
    uploaded_by INT NULL,
    uploaded_by_name VARCHAR(160) NULL,
    uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_lib_version (library_id, version),
    INDEX idx_lib_version_lib (library_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS marketing_library_usage (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    library_id BIGINT NOT NULL,
    module VARCHAR(32) NOT NULL,
    ref_id VARCHAR(64) NOT NULL,
    ref_label VARCHAR(255) NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_lib_usage (library_id, module, ref_id),
    INDEX idx_lib_usage_lib (library_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS marketing_library_audit (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    library_id BIGINT NULL,
    asset_code VARCHAR(32) NULL,
    action VARCHAR(32) NOT NULL,
    detail TEXT NULL,
    user_id INT NULL,
    user_name VARCHAR(160) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_lib_audit_lib (library_id),
    INDEX idx_lib_audit_action (action)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export async function nextAssetId(): Promise<string> {
  return nextRecordId("AST", { allowCustom: true, digits: 5 })
}

export async function recordAudit(
  action: string,
  opts: {
    libraryId?: number | null
    assetCode?: string | null
    detail?: string | null
    userId?: number | null
    userName?: string | null
  },
) {
  await query(
    `INSERT INTO marketing_library_audit (library_id, asset_code, action, detail, user_id, user_name)
     VALUES (?,?,?,?,?,?)`,
    [
      opts.libraryId ?? null,
      opts.assetCode ?? null,
      action,
      opts.detail ?? null,
      opts.userId ?? null,
      opts.userName ?? null,
    ],
  )
}

export type StorageStats = {
  usedBytes: number
  quotaBytes: number
  percentage: number
  assetCount: number
  largest: { asset_id: string; name: string; file_size: number }[]
}

/** Storage Used (Phase 73/75) — summed from actual stored version bytes. */
export async function storageStats(): Promise<StorageStats> {
  const [used] = (await query(
    `SELECT COALESCE(SUM(file_size),0) AS bytes FROM marketing_library_versions`,
  )) as { bytes: number }[]
  const [count] = (await query(`SELECT COUNT(*) AS c FROM marketing_library`)) as { c: number }[]
  const largest = (await query(
    `SELECT asset_id, name, file_size FROM marketing_library ORDER BY file_size DESC LIMIT 5`,
  )) as { asset_id: string; name: string; file_size: number }[]
  const quotaBytes = Number(process.env.LIBRARY_STORAGE_QUOTA_BYTES || DEFAULT_STORAGE_QUOTA_BYTES)
  const usedBytes = Number(used?.bytes || 0)
  return {
    usedBytes,
    quotaBytes,
    percentage: quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0,
    assetCount: Number(count?.c || 0),
    largest,
  }
}

/** Parses a JSON tags column that may arrive as string, array, or null. */
export function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    }
  }
  return []
}

export function humanSize(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Client-safe asset shape. The raw Blob `storage_url` is intentionally omitted
 * (Phase 43) — the browser only ever gets proxy paths that enforce auth.
 */
export function serializeAsset(row: any) {
  return {
    id: Number(row.id),
    assetId: String(row.asset_id),
    name: row.name,
    fileName: row.file_name,
    assetType: row.asset_type,
    category: row.category,
    subcategory: row.subcategory,
    description: row.description,
    tags: parseTags(row.tags),
    folderId: row.folder_id != null ? Number(row.folder_id) : null,
    folderPath: row.folder_path ?? null,
    version: Number(row.current_version || 1),
    status: row.status,
    ownerEmployeeId: row.owner_employee_id,
    ownerName: row.owner_name,
    department: row.department,
    fileSize: Number(row.file_size || 0),
    fileSizeLabel: humanSize(Number(row.file_size || 0)),
    fileType: row.file_type,
    width: row.width != null ? Number(row.width) : null,
    height: row.height != null ? Number(row.height) : null,
    durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    pageCount: row.page_count != null ? Number(row.page_count) : null,
    usageCount: Number(row.usage_count || 0),
    expiryDate: row.expiry_date,
    usageRights: row.usage_rights,
    copyright: row.copyright,
    license: row.license,
    attribution: row.attribution,
    restrictions: row.restrictions,
    licenseExpiry: row.license_expiry,
    source: row.source,
    externalRef: row.external_ref,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    kind: categoryOf(row.file_name || ""),
    previewUrl: `/api/marketing/library/${row.id}/download?preview=1`,
    downloadUrl: `/api/marketing/library/${row.id}/download`,
  }
}

/**
 * Best-effort intrinsic image dimensions from the file header — no dependency,
 * covers PNG / JPEG / GIF. Returns null for anything else (Phase 78).
 */
export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG: width/height are big-endian uint32 at offset 16/20.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset)
    return { width: dv.getUint32(16), height: dv.getUint32(20) }
  }
  // GIF: little-endian uint16 at offset 6/8.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset)
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) }
  }
  // JPEG: scan SOF markers for the frame dimensions.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    const dv = new DataView(bytes.buffer, bytes.byteOffset)
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = bytes[offset + 1]
      // SOF0..SOF15 excluding DHT(0xC4)/DAC(0xCC) carry dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: dv.getUint16(offset + 5), width: dv.getUint16(offset + 7) }
      }
      offset += 2 + dv.getUint16(offset + 2)
    }
  }
  return null
}
