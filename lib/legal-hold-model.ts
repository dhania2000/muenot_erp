/**
 * SPEC 72 — Legal Hold (pure, testable model).
 * ---------------------------------------------------------------------------
 * A legal hold is a named, auditable directive that PROTECTS a set of records
 * or files from destruction while a matter (litigation, audit, regulatory
 * inquiry) is open. While a hold is ACTIVE the covered data must never be
 * removed by an automated retention job (SPEC 71 record retention, SPEC 36
 * storage retention) — the hold always wins over any retention policy.
 *
 * A hold owns one or more ITEMS. Each item declares WHAT it covers via a scope:
 *
 *   - module      — every record type in a business module (broadest ERP scope)
 *   - record_type — one record type (bound to a SPEC 71 catalog key, or a
 *                   module + record-type label for custom types)
 *   - record      — a single record (a record-type target + a record id)
 *   - criteria    — every record of a record-type target whose `matchField`
 *                   equals `matchValue`
 *   - file        — a single storage file (SPEC 32 `file_objects.id`)
 *
 * This module is the DB-free core: scope/status normalization, item-input
 * validation, and the pure predicates the enforcement layer and the settings UI
 * both rely on — mirroring lib/retention-model.ts. It carries no `server-only`,
 * Node or DB import so it can be unit-tested in isolation and shared with the
 * client.
 */

// ---------------------------------------------------------------------------
// Scopes & status
// ---------------------------------------------------------------------------

export const LEGAL_HOLD_SCOPES = ["module", "record_type", "record", "criteria", "file"] as const
export type LegalHoldScope = (typeof LEGAL_HOLD_SCOPES)[number]

export function isLegalHoldScope(value: unknown): value is LegalHoldScope {
  return typeof value === "string" && (LEGAL_HOLD_SCOPES as readonly string[]).includes(value)
}

/** Scopes that carve out INDIVIDUAL ERP records / rows (row-level exclusion). */
export const RECORD_SCOPES: readonly LegalHoldScope[] = ["record", "criteria"]
/** Scopes that hold an ENTIRE record family (whole-policy skip). */
export const FAMILY_SCOPES: readonly LegalHoldScope[] = ["module", "record_type"]

export const LEGAL_HOLD_STATUSES = ["active", "released"] as const
export type LegalHoldStatus = (typeof LEGAL_HOLD_STATUSES)[number]

export function isLegalHoldStatus(value: unknown): value is LegalHoldStatus {
  return typeof value === "string" && (LEGAL_HOLD_STATUSES as readonly string[]).includes(value)
}

export function toLegalHoldStatus(value: unknown): LegalHoldStatus {
  return isLegalHoldStatus(value) ? value : "active"
}

// ---------------------------------------------------------------------------
// Field limits (keep row sizes sane; mirror the retention model's slicing)
// ---------------------------------------------------------------------------

export const LEGAL_HOLD_LIMITS = {
  NAME: 200,
  REASON: 1000,
  MODULE: 96,
  CATALOG_KEY: 120,
  RECORD_TYPE: 160,
  RECORD_REF: 190,
  MATCH_FIELD: 96,
  MATCH_VALUE: 190,
  NOTE: 500,
} as const

function trimTo(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max)
}

// ---------------------------------------------------------------------------
// Targets — the record family an item (and a policy) refer to
// ---------------------------------------------------------------------------

/**
 * The record family a retention policy acts on. The legal-hold enforcement
 * layer compares each hold item against this to decide coverage.
 */
export type PolicyTarget = {
  module: string
  catalogKey: string | null
  recordType: string
}

/** The identifying subset of an item used for target/record matching. */
export type LegalHoldItemMatch = {
  scope: LegalHoldScope
  module: string | null
  catalogKey: string | null
  recordType: string | null
  recordRef: string | null
  matchField: string | null
  matchValue: string | null
  fileId: number | null
}

/**
 * Does an item's record-family target refer to the same family as `policy`?
 * Only meaningful for the ERP-record scopes (module / record_type / record /
 * criteria) — `file` items never target a retention policy.
 *
 * Matching precedence:
 *   1. `module` scope           → module label equality.
 *   2. catalog key on both      → exact catalog-key equality (authoritative).
 *   3. module + record-type     → label equality on both.
 */
export function itemTargetsPolicy(item: LegalHoldItemMatch, policy: PolicyTarget): boolean {
  if (item.scope === "file") return false
  if (item.scope === "module") {
    return item.module != null && item.module === policy.module
  }
  if (item.catalogKey && policy.catalogKey) {
    return item.catalogKey === policy.catalogKey
  }
  if (item.module && item.recordType) {
    return item.module === policy.module && item.recordType === policy.recordType
  }
  // A record-family item with only a module label still guards that module.
  if (item.module) return item.module === policy.module
  return false
}

/**
 * True when ANY active item holds the WHOLE record family the policy acts on
 * (a module- or record-type-scoped hold). The lifecycle job must skip the
 * entire policy in that case.
 */
export function isPolicyFullyHeld(items: LegalHoldItemMatch[], policy: PolicyTarget): boolean {
  return items.some((i) => FAMILY_SCOPES.includes(i.scope) && itemTargetsPolicy(i, policy))
}

/** A record's fields the criteria predicate needs. */
export type HoldEvaluable = {
  id: string | number
  fields: Record<string, unknown>
}

/** Does a single item hold this specific record? Pure. */
export function itemHoldsRecord(item: LegalHoldItemMatch, policy: PolicyTarget, record: HoldEvaluable): boolean {
  if (!RECORD_SCOPES.includes(item.scope)) return false
  if (!itemTargetsPolicy(item, policy)) return false
  if (item.scope === "record") {
    if (item.recordRef == null) return false
    return String(item.recordRef) === String(record.id)
  }
  // criteria
  if (!item.matchField) return false
  const actual = record.fields[item.matchField]
  if (actual == null) return false
  return String(actual) === String(item.matchValue ?? "")
}

/** True when ANY active item holds the record. */
export function isRecordHeld(items: LegalHoldItemMatch[], policy: PolicyTarget, record: HoldEvaluable): boolean {
  return items.some((i) => itemHoldsRecord(i, policy, record))
}

/** The storage-file identity the file predicate needs. */
export type FileEvaluable = { id: number; module: string }

/** Does a single item hold this storage file? Pure. */
export function itemHoldsFile(item: LegalHoldItemMatch, file: FileEvaluable): boolean {
  if (item.scope === "file") {
    return item.fileId != null && Number(item.fileId) === Number(file.id)
  }
  if (item.scope === "module") {
    return item.module != null && item.module === file.module
  }
  return false
}

/** True when ANY active item holds the file. */
export function isFileHeld(items: LegalHoldItemMatch[], file: FileEvaluable): boolean {
  return items.some((i) => itemHoldsFile(i, file))
}

// ---------------------------------------------------------------------------
// Input normalization (shared by the API layer)
// ---------------------------------------------------------------------------

export type NormalizedHoldInput = {
  name: string
  reason: string | null
}

/** Coerce arbitrary request input into a valid hold header. Throws on a missing name. */
export function normalizeHoldInput(input: { name?: unknown; reason?: unknown }): NormalizedHoldInput {
  const name = trimTo(input.name, LEGAL_HOLD_LIMITS.NAME)
  if (!name) throw new Error("A hold name is required")
  const reasonRaw = trimTo(input.reason, LEGAL_HOLD_LIMITS.REASON)
  return { name, reason: reasonRaw || null }
}

export type NormalizedHoldItem = {
  scope: LegalHoldScope
  module: string | null
  catalogKey: string | null
  recordType: string | null
  recordRef: string | null
  matchField: string | null
  matchValue: string | null
  fileId: number | null
  note: string | null
}

/**
 * Validate and normalize a single item. Throws with a user-facing message when
 * the scope's required fields are missing so the API can return a clean 400.
 */
export function normalizeHoldItemInput(input: {
  scope?: unknown
  module?: unknown
  catalogKey?: unknown
  recordType?: unknown
  recordRef?: unknown
  matchField?: unknown
  matchValue?: unknown
  fileId?: unknown
  note?: unknown
}): NormalizedHoldItem {
  if (!isLegalHoldScope(input.scope)) throw new Error("A valid hold scope is required")
  const scope = input.scope

  const module = trimTo(input.module, LEGAL_HOLD_LIMITS.MODULE) || null
  const catalogKey = trimTo(input.catalogKey, LEGAL_HOLD_LIMITS.CATALOG_KEY) || null
  const recordType = trimTo(input.recordType, LEGAL_HOLD_LIMITS.RECORD_TYPE) || null
  const recordRef = trimTo(input.recordRef, LEGAL_HOLD_LIMITS.RECORD_REF) || null
  const matchField = trimTo(input.matchField, LEGAL_HOLD_LIMITS.MATCH_FIELD) || null
  const matchValue = trimTo(input.matchValue, LEGAL_HOLD_LIMITS.MATCH_VALUE) || null
  const note = trimTo(input.note, LEGAL_HOLD_LIMITS.NOTE) || null
  const fileIdNum = Math.floor(Number(input.fileId))
  const fileId = Number.isFinite(fileIdNum) && fileIdNum > 0 ? fileIdNum : null

  // A record-family target: either a catalog key, or a module (+ optional type).
  const hasFamilyTarget = Boolean(catalogKey || module)

  switch (scope) {
    case "module":
      if (!module) throw new Error("A module is required for a module hold")
      return blankItem({ scope, module })
    case "record_type":
      if (!hasFamilyTarget) throw new Error("A record type (catalog key or module) is required")
      return blankItem({ scope, module, catalogKey, recordType })
    case "record":
      if (!hasFamilyTarget) throw new Error("A record type (catalog key or module) is required")
      if (!recordRef) throw new Error("A record reference is required for a record hold")
      return blankItem({ scope, module, catalogKey, recordType, recordRef, note })
    case "criteria":
      if (!hasFamilyTarget) throw new Error("A record type (catalog key or module) is required")
      if (!matchField) throw new Error("A field is required for a criteria hold")
      return blankItem({ scope, module, catalogKey, recordType, matchField, matchValue, note })
    case "file":
      if (fileId == null) throw new Error("A file id is required for a file hold")
      return blankItem({ scope, module, fileId, note })
  }
}

function blankItem(overrides: Partial<NormalizedHoldItem> & { scope: LegalHoldScope }): NormalizedHoldItem {
  return {
    scope: overrides.scope,
    module: overrides.module ?? null,
    catalogKey: overrides.catalogKey ?? null,
    recordType: overrides.recordType ?? null,
    recordRef: overrides.recordRef ?? null,
    matchField: overrides.matchField ?? null,
    matchValue: overrides.matchValue ?? null,
    fileId: overrides.fileId ?? null,
    note: overrides.note ?? null,
  }
}

/** Human label for an item's scope, for audit and UI surfaces. */
export function describeHoldItem(item: NormalizedHoldItem): string {
  switch (item.scope) {
    case "module":
      return `Module: ${item.module}`
    case "record_type":
      return `Record type: ${item.recordType ?? item.catalogKey ?? item.module}`
    case "record":
      return `Record ${item.recordRef} in ${item.recordType ?? item.catalogKey ?? item.module}`
    case "criteria":
      return `Where ${item.matchField} = ${item.matchValue ?? ""} in ${item.recordType ?? item.catalogKey ?? item.module}`
    case "file":
      return `File #${item.fileId}`
  }
}
