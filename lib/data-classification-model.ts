// =============================================================
// Data Classification (pure, testable model)
// -------------------------------------------------------------
// A tenant can classify any module / entity / field with one of five standard
// sensitivity levels. A classification, when its enforcement flags are turned
// on, INFLUENCES three cross-cutting concerns:
//
//   access     — whether a tenant role may read a classified field/record.
//   export     — whether a tenant role may export a classified field.
//   retention  — whether a destructive retention action (delete) may run
//                automatically on a classified record type.
//
// This module is intentionally free of DB / server-only imports so it can be
// unit-tested directly and reused on both the server and (type-only) client.
// The DB store + request wiring live in lib/data-classification.ts.
// =============================================================

import { type TenantRole, tenantRank, tenantAtLeast, toTenantRole } from "@/lib/role-model"

/** The five standard sensitivity levels, ordered least → most sensitive. */
export const CLASSIFICATION_LEVELS = [
  "Public",
  "Internal",
  "Confidential",
  "Restricted",
  "Highly Restricted",
] as const

export type ClassificationLevel = (typeof CLASSIFICATION_LEVELS)[number]

/** Rank within the sensitivity axis. Higher = more sensitive. */
const LEVEL_RANK: Record<ClassificationLevel, number> = {
  Public: 0,
  Internal: 10,
  Confidential: 20,
  Restricted: 30,
  "Highly Restricted": 40,
}

export function isClassificationLevel(value: unknown): value is ClassificationLevel {
  return typeof value === "string" && (CLASSIFICATION_LEVELS as readonly string[]).includes(value)
}

/** Normalize an unknown value to a valid level, defaulting to `Internal`. */
export function toClassificationLevel(value: unknown): ClassificationLevel {
  return isClassificationLevel(value) ? value : "Internal"
}

export function levelRank(level: ClassificationLevel): number {
  return LEVEL_RANK[level] ?? 0
}

/** True when `level` is at least as sensitive as `min`. */
export function levelAtLeast(level: ClassificationLevel, min: ClassificationLevel): boolean {
  return levelRank(level) >= levelRank(min)
}

/** The more sensitive of two levels (used to roll a record up from its fields). */
export function maxLevel(a: ClassificationLevel, b: ClassificationLevel): ClassificationLevel {
  return levelRank(a) >= levelRank(b) ? a : b
}

// ---------------------------------------------------------------------------
// Clearance matrix — the tenant-configurable policy that turns a level into a
// minimum tenant role required to ACCESS and to EXPORT data at that level, plus
// whether destructive retention may run automatically at that level.
// ---------------------------------------------------------------------------

export type ClearanceRule = {
  /** Minimum tenant role required to view fields/records at this level. */
  accessMinRole: TenantRole
  /** Minimum tenant role required to export fields at this level. */
  exportMinRole: TenantRole
  /**
   * Whether an automatic destructive retention action (Delete) may run on a
   * record type classified at this level. High-sensitivity records default to
   * false so they are never silently auto-deleted without explicit review.
   */
  allowAutoDelete: boolean
}

export type ClearanceMatrix = Record<ClassificationLevel, ClearanceRule>

/**
 * Sensible enterprise defaults. Public/Internal are broadly accessible;
 * Confidential requires an elevated (module-admin) clearance; Restricted and
 * Highly Restricted require tenant-admin / tenant-owner clearance and are never
 * auto-deleted.
 */
export const DEFAULT_CLEARANCE_MATRIX: ClearanceMatrix = {
  Public: { accessMinRole: "employee", exportMinRole: "employee", allowAutoDelete: true },
  Internal: { accessMinRole: "employee", exportMinRole: "employee", allowAutoDelete: true },
  Confidential: { accessMinRole: "module_admin", exportMinRole: "module_admin", allowAutoDelete: true },
  Restricted: { accessMinRole: "tenant_admin", exportMinRole: "tenant_admin", allowAutoDelete: false },
  "Highly Restricted": { accessMinRole: "tenant_owner", exportMinRole: "tenant_owner", allowAutoDelete: false },
}

/**
 * Coerce arbitrary (possibly persisted/partial) input into a complete, valid
 * clearance matrix. Unknown levels are ignored and missing fields fall back to
 * the defaults, so a malformed stored value can never widen or break access.
 */
export function normalizeClearanceMatrix(input: unknown): ClearanceMatrix {
  const out: ClearanceMatrix = structuredCloneMatrix(DEFAULT_CLEARANCE_MATRIX)
  if (!input || typeof input !== "object") return out
  for (const level of CLASSIFICATION_LEVELS) {
    const raw = (input as Record<string, unknown>)[level]
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const fallback = DEFAULT_CLEARANCE_MATRIX[level]
    out[level] = {
      accessMinRole: "accessMinRole" in r ? toTenantRole(r.accessMinRole) : fallback.accessMinRole,
      exportMinRole: "exportMinRole" in r ? toTenantRole(r.exportMinRole) : fallback.exportMinRole,
      allowAutoDelete: typeof r.allowAutoDelete === "boolean" ? r.allowAutoDelete : fallback.allowAutoDelete,
    }
  }
  return out
}

function structuredCloneMatrix(m: ClearanceMatrix): ClearanceMatrix {
  return Object.fromEntries(CLASSIFICATION_LEVELS.map((l) => [l, { ...m[l] }])) as ClearanceMatrix
}

// ---------------------------------------------------------------------------
// Enforcement decisions — pure functions consumed by the access / export /
// retention surfaces "where configured".
// ---------------------------------------------------------------------------

/** Whether a role clears the ACCESS bar for a level under the given matrix. */
export function canAccessClassification(
  level: ClassificationLevel,
  role: TenantRole,
  matrix: ClearanceMatrix = DEFAULT_CLEARANCE_MATRIX,
): boolean {
  return tenantAtLeast(role, matrix[level].accessMinRole)
}

/** Whether a role clears the EXPORT bar for a level under the given matrix. */
export function canExportClassification(
  level: ClassificationLevel,
  role: TenantRole,
  matrix: ClearanceMatrix = DEFAULT_CLEARANCE_MATRIX,
): boolean {
  return tenantAtLeast(role, matrix[level].exportMinRole)
}

/**
 * Whether a destructive retention action may run automatically at this level.
 * Non-destructive actions (Archive) are always allowed; only Delete is gated.
 */
export function canAutoDeleteAtLevel(
  level: ClassificationLevel,
  matrix: ClearanceMatrix = DEFAULT_CLEARANCE_MATRIX,
): boolean {
  return matrix[level].allowAutoDelete
}

/** A field/level pair, used when deciding what to redact from an export. */
export type ClassifiedField = { field: string; level: ClassificationLevel; enforceExport?: boolean }

/**
 * Given the classified fields of an entity and the acting role, return the set
 * of field names the role is NOT allowed to export. Only fields whose mapping
 * has export enforcement enabled are considered.
 */
export function redactedExportFields(
  fields: ClassifiedField[],
  role: TenantRole,
  matrix: ClearanceMatrix = DEFAULT_CLEARANCE_MATRIX,
): Set<string> {
  const redacted = new Set<string>()
  for (const f of fields) {
    if (f.enforceExport === false) continue
    if (!canExportClassification(f.level, role, matrix)) redacted.add(f.field)
  }
  return redacted
}

/** Roll an entity's classified fields up to the single highest level present. */
export function recordClassification(fields: { level: ClassificationLevel }[]): ClassificationLevel | null {
  if (fields.length === 0) return null
  return fields.reduce<ClassificationLevel>((acc, f) => maxLevel(acc, f.level), "Public")
}

export { tenantRank, tenantAtLeast, type TenantRole }
