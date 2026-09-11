import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Employee Documents — shared schema, master data and helpers.
//
// Centralizes the self-healing schema upgrade for `hr_employee_documents`, the
// `hr_document_types` master (which drives the Document Type dropdown, the
// required-document checklist and expiry configuration), and the pure helpers
// used by the API, the /related profile endpoint and the client.
// ---------------------------------------------------------------------------

export type ExpiryStatus = "None" | "Valid" | "Expiring Soon" | "Expired"

export type DocumentType = {
  id: number
  type_name: string
  is_required: 0 | 1
  has_expiry: 0 | 1
  expiry_warn_days: number
  status: string
  sort_order: number
}

/** Default lead time (days) used to flag a document as "Expiring Soon". */
export const DEFAULT_EXPIRY_WARN_DAYS = 30

// The document types the ERP already supports (from the legacy hard-coded list)
// plus the common travel/exit types HR needs. Seeded once; HR can edit them via
// HR Master Data → Document Types afterwards. type_name values MUST include the
// legacy strings verbatim so existing documents keep matching their type.
const SEED_TYPES: Array<Pick<DocumentType, "type_name" | "is_required" | "has_expiry">> = [
  { type_name: "Profile Photo", is_required: 0, has_expiry: 0 },
  { type_name: "PAN", is_required: 1, has_expiry: 0 },
  { type_name: "Aadhar", is_required: 1, has_expiry: 0 },
  { type_name: "Bank PassBook/Cancel Cheque", is_required: 1, has_expiry: 0 },
  { type_name: "Highest Qualification Degree", is_required: 1, has_expiry: 0 },
  { type_name: "Experience Certificate 1", is_required: 0, has_expiry: 0 },
  { type_name: "Experience Certificate 2", is_required: 0, has_expiry: 0 },
  { type_name: "Experience Certificate 3", is_required: 0, has_expiry: 0 },
  { type_name: "Certificate (If Any)", is_required: 0, has_expiry: 0 },
  { type_name: "Address Proof", is_required: 0, has_expiry: 0 },
  { type_name: "Passport", is_required: 0, has_expiry: 1 },
  { type_name: "Driving Licence", is_required: 0, has_expiry: 1 },
  { type_name: "Offer Letter", is_required: 0, has_expiry: 0 },
  { type_name: "Appointment Letter", is_required: 0, has_expiry: 0 },
  { type_name: "NDA", is_required: 0, has_expiry: 0 },
  { type_name: "Relieving Letter", is_required: 0, has_expiry: 0 },
  { type_name: "Experience Letter", is_required: 0, has_expiry: 0 },
  { type_name: "NOC", is_required: 0, has_expiry: 0 },
  { type_name: "Other Document", is_required: 0, has_expiry: 0 },
]

let docsEnsured: Promise<void> | null = null
let typesEnsured: Promise<void> | null = null

/**
 * Idempotently upgrade `hr_employee_documents` with the metadata, verification,
 * versioning, expiry and archive columns — plus the LONGBLOB storage columns.
 * Each ALTER is guarded so one existing column never aborts the rest, mirroring
 * the ensure* pattern used across the HR modules.
 */
export function ensureEmployeeDocumentsSchema(): Promise<void> {
  if (!docsEnsured) docsEnsured = doEnsureDocs()
  return docsEnsured
}

async function doEnsureDocs() {
  const additions = [
    "ADD COLUMN `document_ref` VARCHAR(40) DEFAULT NULL",
    "ADD COLUMN `document_number` VARCHAR(120) DEFAULT NULL",
    "ADD COLUMN `issue_date` DATE DEFAULT NULL",
    "ADD COLUMN `expiry_date` DATE DEFAULT NULL",
    "ADD COLUMN `version` INT UNSIGNED NOT NULL DEFAULT 1",
    "ADD COLUMN `is_current` TINYINT(1) NOT NULL DEFAULT 1",
    "ADD COLUMN `supersedes_id` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN `uploaded_by` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN `rejection_reason` TEXT DEFAULT NULL",
    "ADD COLUMN `rejected_by` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN `rejected_at` DATETIME DEFAULT NULL",
    "ADD COLUMN `archived_at` DATETIME DEFAULT NULL",
    "ADD COLUMN `archived_by` INT UNSIGNED DEFAULT NULL",
    "ADD COLUMN `file_data` LONGBLOB NULL",
    "ADD COLUMN `file_mime` VARCHAR(150) NULL",
  ]
  // Resolve which columns already exist so we only add the missing ones (some
  // MySQL/MariaDB builds don't support ADD COLUMN IF NOT EXISTS).
  const existing = await query<{ COLUMN_NAME: string }[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employee_documents'`,
  ).catch(() => [] as { COLUMN_NAME: string }[])
  const have = new Set(existing.map((c) => c.COLUMN_NAME))
  for (const clause of additions) {
    const col = clause.match(/`([^`]+)`/)?.[1]
    if (col && have.has(col)) continue
    try {
      await query(`ALTER TABLE hr_employee_documents ${clause}`)
    } catch {
      // Column already present on a server without IF NOT EXISTS support.
    }
  }

  // Best-effort indexes for the frequently filtered/searched columns.
  for (const idx of [
    "ADD KEY `idx_hr_doc_ref` (`document_ref`)",
    "ADD KEY `idx_hr_doc_type` (`document_type`)",
    "ADD KEY `idx_hr_doc_status` (`status`)",
    "ADD KEY `idx_hr_doc_current` (`is_current`)",
    "ADD KEY `idx_hr_doc_expiry` (`expiry_date`)",
    "ADD KEY `idx_hr_doc_archived` (`archived_at`)",
  ]) {
    try {
      await query(`ALTER TABLE hr_employee_documents ${idx}`)
    } catch {
      // Index already exists.
    }
  }

  // Backfill document_ref for any legacy rows that predate the ref column so
  // every document has a stable, human-readable identifier.
  try {
    const legacy = await query<{ id: number }[]>(
      "SELECT id FROM hr_employee_documents WHERE document_ref IS NULL OR document_ref = '' ORDER BY id ASC",
    )
    for (const row of legacy) {
      await query("UPDATE hr_employee_documents SET document_ref = ? WHERE id = ?", [
        `DOC-${String(row.id).padStart(6, "0")}`,
        row.id,
      ])
    }
  } catch {
    // Non-fatal: refs are also generated going forward via nextRecordId.
  }
}

/** Create + seed the document-types master. Safe to call repeatedly. */
export function ensureDocumentTypesSchema(): Promise<void> {
  if (!typesEnsured) typesEnsured = doEnsureTypes()
  return typesEnsured
}

async function doEnsureTypes() {
  await query(`CREATE TABLE IF NOT EXISTS hr_document_types (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    type_name VARCHAR(120) NOT NULL,
    is_required TINYINT(1) NOT NULL DEFAULT 0,
    has_expiry TINYINT(1) NOT NULL DEFAULT 0,
    expiry_warn_days INT UNSIGNED NOT NULL DEFAULT 30,
    status VARCHAR(30) NOT NULL DEFAULT 'Active',
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_hr_doc_type_name (type_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Seed only when empty so HR edits are never overwritten.
  const count = await query<{ c: number }[]>("SELECT COUNT(*) AS c FROM hr_document_types")
  if (Number(count[0]?.c || 0) > 0) return
  let order = 0
  for (const t of SEED_TYPES) {
    order += 10
    await query(
      "INSERT IGNORE INTO hr_document_types (type_name, is_required, has_expiry, expiry_warn_days, status, sort_order) VALUES (?,?,?,?, 'Active', ?)",
      [t.type_name, t.is_required, t.has_expiry, DEFAULT_EXPIRY_WARN_DAYS, order],
    )
  }
}

/** All active document types, ordered for display. */
export async function getDocumentTypes(includeInactive = false): Promise<DocumentType[]> {
  await ensureDocumentTypesSchema()
  const rows = await query<DocumentType[]>(
    `SELECT id, type_name, is_required, has_expiry, expiry_warn_days, status, sort_order
       FROM hr_document_types
       ${includeInactive ? "" : "WHERE status = 'Active'"}
       ORDER BY sort_order ASC, type_name ASC`,
  )
  return rows
}

/**
 * Classify a document's expiry. Types without an expiry date (or without an
 * expiry requirement) return "None". Warn window is per-type-configurable.
 */
export function expiryStatus(
  expiryDate: string | null | undefined,
  warnDays: number = DEFAULT_EXPIRY_WARN_DAYS,
): ExpiryStatus {
  if (!expiryDate) return "None"
  const d = new Date(expiryDate)
  if (Number.isNaN(d.getTime())) return "None"
  d.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.floor((d.getTime() - today.getTime()) / 86_400_000)
  if (days < 0) return "Expired"
  if (days <= Math.max(0, warnDays)) return "Expiring Soon"
  return "Valid"
}

/** Number of whole days until expiry (negative when already expired). */
export function daysUntil(expiryDate: string | null | undefined): number | null {
  if (!expiryDate) return null
  const d = new Date(expiryDate)
  if (Number.isNaN(d.getTime())) return null
  d.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.floor((d.getTime() - today.getTime()) / 86_400_000)
}
