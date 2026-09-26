/**
 * SPEC 35 — Critical-record registry (pure).
 * ---------------------------------------------------------------------------
 * The single allow-list of records that participate in soft delete, the
 * recycle bin and versioned sensitive edits. Every table/column identifier
 * that reaches dynamic SQL in lib/recycle-bin/store.ts comes from here — never
 * from request input — so a forged entityType or payload key cannot address an
 * arbitrary table or column.
 *
 * Each registered table carries the consistent soft-delete trio:
 *   deleted_at  DATETIME     — when it was moved to the recycle bin
 *   deleted_by  INT UNSIGNED — who moved it
 *   delete_reason VARCHAR    — why (required by policy, see normalizeDeleteReason)
 * Soft delete keeps the row in place (same PK, same FK columns), which is what
 * makes restore reference-preserving by construction.
 */

export type FieldKind = "money" | "int" | "text" | "user_id" | "currency"

export type VersionedField = {
  label: string
  kind: FieldKind
  /** Inclusive bounds for numeric kinds; max length for text kinds. */
  min?: number
  max?: number
}

export type CriticalEntityDef = {
  entityType: string
  label: string
  table: string
  /** Legal-hold / retention module key. */
  module: string
  /** Feature slug required to delete or propose edits (lib/permissions.ts). */
  featureSlug: string
  /** Columns used to build a human label for recycle-bin listings. */
  labelColumns: readonly string[]
  /** Table has an optimistic-lock `row_version` column. */
  hasRowVersion: boolean
  /** Fields that may be changed through a versioned (approval-gated) edit. */
  versionedFields: Readonly<Record<string, VersionedField>>
  /** Fields gated by default when a tenant has not customised its policy. */
  defaultApprovalFields: readonly string[]
}

export const CRITICAL_ENTITIES: Readonly<Record<string, CriticalEntityDef>> = {
  client: {
    entityType: "client",
    label: "Client",
    table: "clients",
    module: "crm",
    featureSlug: "clients.manage_clients",
    labelColumns: ["display_name", "company_name", "client_name", "client_code"],
    hasRowVersion: true,
    versionedFields: {
      credit_limit: { label: "Credit limit", kind: "money", min: 0, max: 1_000_000_000_000 },
      payment_terms_days: { label: "Payment terms (days)", kind: "int", min: 0, max: 365 },
      legal_name: { label: "Legal name", kind: "text", max: 190 },
      currency: { label: "Currency", kind: "currency" },
      account_manager_id: { label: "Account manager", kind: "user_id" },
    },
    defaultApprovalFields: ["credit_limit", "payment_terms_days"],
  },
}

export function getCriticalEntity(entityType: unknown): CriticalEntityDef | null {
  if (typeof entityType !== "string") return null
  return Object.prototype.hasOwnProperty.call(CRITICAL_ENTITIES, entityType) ? CRITICAL_ENTITIES[entityType] : null
}

export function listCriticalEntities(): CriticalEntityDef[] {
  return Object.values(CRITICAL_ENTITIES)
}

/** A positive integer primary key, or null. Critical tables all use INT ids. */
export function parseEntityPk(value: unknown): number | null {
  const s = String(value ?? "").trim()
  if (!/^[1-9][0-9]{0,15}$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

export function entityLabel(def: CriticalEntityDef, row: Record<string, unknown>): string {
  for (const col of def.labelColumns) {
    const v = row[col]
    if (v != null && String(v).trim()) return String(v).trim().slice(0, 255)
  }
  return `${def.label} #${row.id}`
}

// ---------------------------------------------------------------------------
// Value normalization / comparison
// ---------------------------------------------------------------------------

export type FieldValidation = { ok: true; value: string | number | null } | { ok: false; message: string }

/** Validate one proposed value against its field definition. Empty string -> null. */
export function validateFieldValue(field: VersionedField, raw: unknown): FieldValidation {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null }
  if (typeof raw === "object" || typeof raw === "boolean") return { ok: false, message: `${field.label} has an invalid value` }
  switch (field.kind) {
    case "money":
    case "int": {
      const n = Number(raw)
      if (!Number.isFinite(n)) return { ok: false, message: `${field.label} must be a number` }
      if (field.kind === "int" && !Number.isInteger(n)) return { ok: false, message: `${field.label} must be a whole number` }
      if (field.min != null && n < field.min) return { ok: false, message: `${field.label} must be at least ${field.min}` }
      if (field.max != null && n > field.max) return { ok: false, message: `${field.label} must be at most ${field.max}` }
      return { ok: true, value: field.kind === "money" ? Math.round(n * 100) / 100 : n }
    }
    case "user_id": {
      const id = parseEntityPk(raw)
      return id == null ? { ok: false, message: `${field.label} must be a valid user` } : { ok: true, value: id }
    }
    case "currency": {
      const c = String(raw).trim().toUpperCase()
      return /^[A-Z]{3}$/.test(c) ? { ok: true, value: c } : { ok: false, message: `${field.label} must be a 3-letter ISO code` }
    }
    case "text": {
      const t = String(raw).trim()
      if (!t) return { ok: true, value: null }
      if (field.max != null && t.length > field.max) return { ok: false, message: `${field.label} is too long` }
      return { ok: true, value: t }
    }
  }
}

/**
 * Canonical comparable form of a stored or proposed value, so DECIMAL "5000.00"
 * from MySQL equals the number 5000 and "" equals NULL.
 */
export function canonicalValue(field: VersionedField | undefined, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null
  if (field && (field.kind === "money" || field.kind === "int" || field.kind === "user_id")) {
    const n = Number(v)
    return Number.isFinite(n) ? String(field.kind === "money" ? Math.round(n * 100) / 100 : n) : String(v)
  }
  if (field?.kind === "currency") return String(v).trim().toUpperCase()
  return String(v).trim()
}

export function valuesEqual(field: VersionedField | undefined, a: unknown, b: unknown): boolean {
  return canonicalValue(field, a) === canonicalValue(field, b)
}

/** Keep only the policy fields that are actually versionable for the entity. */
export function sanitizePolicyFields(def: CriticalEntityDef, fields: unknown): string[] {
  if (!Array.isArray(fields)) return []
  const out = new Set<string>()
  for (const f of fields) if (typeof f === "string" && def.versionedFields[f]) out.add(f)
  return [...out]
}

/**
 * Which gated fields a direct (non-versioned) edit would change. A non-empty
 * result means the edit must go through the version + approval workflow.
 */
export function gatedChanges(
  def: CriticalEntityDef,
  gatedFields: readonly string[],
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): string[] {
  return gatedFields.filter(
    (f) => Object.prototype.hasOwnProperty.call(patch, f) && !valuesEqual(def.versionedFields[f], existing[f], patch[f]),
  )
}
