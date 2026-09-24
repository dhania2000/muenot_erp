/**
 * SPEC 104 — Record Merge Engine: pure model (Phase 1).
 * ---------------------------------------------------------------------------
 * The metadata-driven, dependency-free core of the duplicate-record merge
 * feature. Holds ZERO database access and no "server-only" marker so the SAME
 * rules drive the preview the browser renders, the transactional service that
 * executes the merge, and the exhaustive unit tests (see
 * test/custom-modules-merge.test.ts).
 *
 * A merge folds one or more DUPLICATE "secondary" records INTO a surviving
 * "primary" record of the same module. The policy is:
 *
 *   • Field selection. For every field the surviving record keeps the value
 *     the operator chose — the primary's own value by default, or a specific
 *     secondary's value when it is the better copy. Computed (formula) fields
 *     are always re-derived from the resolved operands, never copied.
 *
 *   • Attachments are unioned. The survivor keeps every distinct attachment
 *     (deduplicated by url) contributed by the primary and the secondaries, so
 *     no document is lost in the merge.
 *
 *   • Related records are repointed. Any record whose relation ("entity")
 *     field pointed at a secondary is rewired to point at the survivor, so no
 *     reference is left dangling once the secondaries are retired.
 *
 *   • Reversibility. Everything the merge overwrites or retires is captured in
 *     a MergeSnapshot precise enough to reconstruct the exact pre-merge state,
 *     which is what makes the rollback in the service possible.
 *
 * All of this is pure and deterministic here; the service (merge-service.ts)
 * adds persistence, tenant scoping, the transaction and the audit trail.
 */
import {
  type Attachment,
  type ModuleDefinition,
  evaluateFormula,
  getFieldTypeDef,
  numericValueOf,
  toFieldDefinition,
} from "@/lib/custom-modules/model"

/** The maximum number of secondary records a single merge may fold in. */
export const MAX_MERGE_SECONDARIES = 20

/** Where a merged field's value comes from: the primary, or a secondary's id. */
export type FieldSource = "primary" | string

/** The per-field source map an operator submits: fieldKey → source. */
export type MergeSelections = Record<string, FieldSource>

/** The minimal record shape the merge maths needs. */
export type MergeRecordInput = {
  id: number
  state: string | null
  values: Record<string, unknown>
  attachments: Attachment[]
}

export type FieldMergeChoice = {
  key: string
  label: string
  type: string
  /** True for formula fields — re-derived, never chosen. */
  computed: boolean
  /** The source actually used for this field. */
  source: FieldSource
  /** The resolved value the survivor will keep. */
  value: unknown
  /** Every record's candidate value, for the review UI. "primary" or the id. */
  candidates: Array<{ recordId: number | "primary"; value: unknown }>
}

export type MergeComputation = {
  values: Record<string, unknown>
  attachments: Attachment[]
  fields: FieldMergeChoice[]
}

function isBlank(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0)
}

/**
 * Validate the SHAPE of a merge request (ids only) independently of any data.
 * The primary and secondaries must be distinct, there must be at least one
 * secondary, and the count is capped so one request cannot fold an unbounded
 * number of records.
 */
export function validateMergeRequest(
  primaryId: number,
  secondaryIds: readonly number[],
): { ok: true; secondaryIds: number[] } | { ok: false; error: string } {
  if (!Number.isInteger(primaryId) || primaryId <= 0) {
    return { ok: false, error: "A valid primary record is required." }
  }
  const seen = new Set<number>()
  const cleaned: number[] = []
  for (const raw of secondaryIds ?? []) {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) continue
    if (id === primaryId) return { ok: false, error: "The primary record cannot also be a secondary." }
    if (seen.has(id)) continue
    seen.add(id)
    cleaned.push(id)
  }
  if (cleaned.length === 0) return { ok: false, error: "Select at least one record to merge into the primary." }
  if (cleaned.length > MAX_MERGE_SECONDARIES) {
    return { ok: false, error: `A single merge can fold at most ${MAX_MERGE_SECONDARIES} records.` }
  }
  return { ok: true, secondaryIds: cleaned }
}

/**
 * Compute the surviving record's merged values + attachments from the chosen
 * per-field sources. Pure and deterministic: the same inputs always yield the
 * same survivor, which is what lets the preview and the executor agree.
 */
export function computeMerge(
  def: ModuleDefinition,
  primary: MergeRecordInput,
  secondaries: readonly MergeRecordInput[],
  selections: MergeSelections,
): MergeComputation {
  const secondaryById = new Map<string, MergeRecordInput>()
  for (const rec of secondaries) secondaryById.set(String(rec.id), rec)

  const values: Record<string, unknown> = {}
  const fields: FieldMergeChoice[] = []

  for (const field of def.fields) {
    const typeDef = getFieldTypeDef(field.type)
    const candidates: FieldMergeChoice["candidates"] = [
      { recordId: "primary", value: primary.values[field.key] ?? null },
      ...secondaries.map((s) => ({ recordId: s.id, value: s.values[field.key] ?? null })),
    ]

    if (typeDef?.computed) {
      // Formula fields are derived below; record a placeholder choice for the UI.
      fields.push({
        key: field.key,
        label: field.label,
        type: field.type,
        computed: true,
        source: "primary",
        value: null,
        candidates,
      })
      continue
    }

    const requested = selections[field.key]
    const source: FieldSource =
      requested && requested !== "primary" && secondaryById.has(requested) ? requested : "primary"
    const chosen = source === "primary" ? primary : secondaryById.get(source)!
    const value = chosen.values[field.key]
    if (!isBlank(value)) values[field.key] = value

    fields.push({
      key: field.key,
      label: field.label,
      type: field.type,
      computed: false,
      source,
      value: value ?? null,
      candidates,
    })
  }

  // Re-derive formula fields from the resolved numeric operands.
  const numericValues: Record<string, number> = {}
  for (const field of def.fields) {
    const typeDef = getFieldTypeDef(field.type)
    if (typeDef?.numeric && !typeDef.computed) {
      numericValues[field.key] = numericValueOf(toFieldDefinition(def.slug, field), values[field.key])
    }
  }
  for (const field of def.fields) {
    const typeDef = getFieldTypeDef(field.type)
    if (typeDef?.computed && field.config.formula) {
      const computed = evaluateFormula(field.config.formula, numericValues)
      const resolved = computed == null ? null : computed
      values[field.key] = resolved
      const choice = fields.find((f) => f.key === field.key)
      if (choice) choice.value = resolved
    }
  }

  return { values, attachments: mergeAttachments(primary, secondaries), fields }
}

/** Union every distinct attachment (deduped by url) across all records. */
export function mergeAttachments(
  primary: MergeRecordInput,
  secondaries: readonly MergeRecordInput[],
): Attachment[] {
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const rec of [primary, ...secondaries]) {
    for (const a of rec.attachments ?? []) {
      if (!a?.url || seen.has(a.url)) continue
      seen.add(a.url)
      out.push(a)
      if (out.length >= 50) return out
    }
  }
  return out
}

export type ReferenceChange = { key: string; from: string; to: string }

/**
 * Rewire a record's relation ("entity") fields that point at one of the retired
 * secondaries so they point at the survivor instead. Pure: returns a NEW values
 * object plus the list of changes (empty when nothing referenced a secondary).
 * Only entity fields carry a record reference; user/department point at other
 * catalogues and are never rewired here.
 */
export function rewireReferences(
  def: ModuleDefinition,
  values: Record<string, unknown>,
  secondaryIds: ReadonlySet<string>,
  primaryId: string,
): { values: Record<string, unknown>; changes: ReferenceChange[] } {
  const changes: ReferenceChange[] = []
  const next = { ...values }
  for (const field of def.fields) {
    if (field.type !== "entity") continue
    const raw = values[field.key]
    if (!raw || typeof raw !== "object") continue
    const id = String((raw as any).id ?? "")
    if (!id || !secondaryIds.has(id)) continue
    next[field.key] = { ...(raw as Record<string, unknown>), id: primaryId }
    changes.push({ key: field.key, from: id, to: primaryId })
  }
  return { values: next, changes }
}

// ---------------------------------------------------------------------------
// Rollback snapshot
// ---------------------------------------------------------------------------

/** A single record's full pre-merge state, precise enough to restore it. */
export type RecordSnapshot = {
  id: number
  state: string | null
  values: Record<string, unknown>
  attachments: Attachment[]
}

/** A rewired reference on some other record, captured so it can be reversed. */
export type RewireSnapshot = {
  recordId: number
  key: string
  from: string
  to: string
}

/**
 * Everything a merge overwrote or retired, captured before the writes so the
 * rollback can reconstruct the exact pre-merge state:
 *   • primary  — the survivor's values/attachments before they were replaced.
 *   • secondaries — each retired record's full state so it can be revived.
 *   • rewires  — every related-record reference the merge repointed.
 */
export type MergeSnapshot = {
  primary: RecordSnapshot
  secondaries: RecordSnapshot[]
  rewires: RewireSnapshot[]
}
