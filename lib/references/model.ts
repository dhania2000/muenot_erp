/**
 * SPEC 93 — Reference Number Management: pure model (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * This module holds ZERO database access. It encodes the reference-number
 * FRAMEWORK: the set of reference types a business document can carry, the
 * documents that can carry them, how a raw value is normalized for comparison,
 * and the per-(document, reference) configuration that decides whether a type
 * is captured, required, and duplicate-checked.
 *
 * It is deliberately client-safe (no "server-only", no db import) so the same
 * rules drive validation in the browser, the admin console preview, and the
 * server, and can be unit-tested without a live DB (see test/references.test.ts).
 *
 * Where SPEC 92 (lib/numbering) generates the INTERNAL number a document is
 * issued under, SPEC 93 sits alongside it and manages every OTHER reference the
 * document is known by — the counterparties' and related documents' numbers:
 *
 *   Internal number     the tenant's own id (usually from the numbering engine)
 *   External reference   a free-form external/legacy id
 *   Customer reference   the customer's own number for this document (their PO)
 *   Vendor reference     the vendor's own number (their invoice/quote no.)
 *   PO reference         the linked purchase-order number
 *   Contract reference   the governing contract number
 */

// ---------------------------------------------------------------------------
// Reference types (the six the spec enumerates)
// ---------------------------------------------------------------------------

export type ReferenceType =
  | "internal"
  | "external"
  | "customer"
  | "vendor"
  | "po"
  | "contract"

export type ReferenceTypeDef = {
  type: ReferenceType
  label: string
  description: string
}

export const REFERENCE_TYPES: readonly ReferenceTypeDef[] = [
  { type: "internal", label: "Internal number", description: "The tenant's own number for this document." },
  { type: "external", label: "External reference", description: "A free-form external, legacy or partner id." },
  { type: "customer", label: "Customer reference", description: "The customer's own number (e.g. their PO number)." },
  { type: "vendor", label: "Vendor reference", description: "The vendor's own number (e.g. their invoice number)." },
  { type: "po", label: "PO reference", description: "The linked purchase-order number." },
  { type: "contract", label: "Contract reference", description: "The governing contract number." },
] as const

const REFERENCE_TYPE_SET = new Set<string>(REFERENCE_TYPES.map((r) => r.type))

export function isReferenceType(value: string): value is ReferenceType {
  return REFERENCE_TYPE_SET.has(value)
}

export function referenceTypeLabel(type: string): string {
  return REFERENCE_TYPES.find((r) => r.type === type)?.label ?? type
}

// ---------------------------------------------------------------------------
// Duplicate-detection policy
// ---------------------------------------------------------------------------

/**
 * How a captured reference value is checked against existing values for the
 * SAME (document type, reference type) under the tenant:
 *   off   — never checked; any value is accepted.
 *   warn  — duplicates are surfaced to the caller but the value is still saved.
 *   block — a duplicate is rejected; the value cannot be saved.
 */
export type DuplicatePolicy = "off" | "warn" | "block"

export const DUPLICATE_POLICIES: readonly DuplicatePolicy[] = ["off", "warn", "block"] as const

export function isDuplicatePolicy(value: string): value is DuplicatePolicy {
  return value === "off" || value === "warn" || value === "block"
}

// ---------------------------------------------------------------------------
// Value normalization (the heart of duplicate detection)
// ---------------------------------------------------------------------------

/**
 * The value stored/displayed: trimmed, with internal whitespace collapsed.
 * Casing is preserved so the reference reads the way the counterparty wrote it.
 */
export function cleanRefValue(value: string): string {
  return String(value ?? "").trim().replace(/\s+/g, " ")
}

/**
 * The comparison key used for duplicate detection. Two values collide iff their
 * keys are equal, so detection is case-insensitive and ignores punctuation and
 * spacing: "PO-1234", "po 1234" and "Po1234" are all the same reference.
 * Returns "" for a blank value (blanks never collide).
 */
export function duplicateKey(value: string): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

// ---------------------------------------------------------------------------
// Document catalogue — which business documents carry references
// ---------------------------------------------------------------------------

/** Per-(document, reference) configuration. */
export type ReferenceConfig = {
  docType: string
  refType: ReferenceType
  enabled: boolean
  required: boolean
  duplicate: DuplicatePolicy
}

/** A single reference type's default configuration on a document. */
type RefDefault = {
  refType: ReferenceType
  enabled?: boolean
  required?: boolean
  duplicate?: DuplicatePolicy
}

export type DocumentTypeDef = {
  docType: string
  label: string
  module: string
  /** The default config for every reference type on this document. */
  defaults: ReferenceConfig[]
}

function normalizeDocType(docType: string): string {
  return String(docType ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "")
}

/**
 * Build a document definition. Any reference type not named in `refs` is still
 * present but disabled by default, so every document has a complete, explicit
 * configuration row for all six reference types.
 */
function doc(docType: string, label: string, module: string, refs: RefDefault[]): DocumentTypeDef {
  const byType = new Map<ReferenceType, RefDefault>()
  for (const r of refs) byType.set(r.refType, r)
  const defaults: ReferenceConfig[] = REFERENCE_TYPES.map((t) => {
    const r = byType.get(t.type)
    return {
      docType,
      refType: t.type,
      enabled: r ? r.enabled !== false : false,
      required: r ? r.required === true : false,
      duplicate: r?.duplicate ?? "off",
    }
  })
  return { docType, label, module, defaults }
}

/**
 * The catalogue of business documents that participate in reference
 * management, each with a sensible default configuration. Internal numbers are
 * duplicate-blocked everywhere (they must be unique); the counterparty and
 * linked-document references default to warn or off. Tenants tailor these in
 * the admin console.
 */
export const DOCUMENT_TYPES: readonly DocumentTypeDef[] = [
  doc("INV", "Sales invoice", "Finance", [
    { refType: "internal", required: true, duplicate: "block" },
    { refType: "external", duplicate: "warn" },
    { refType: "customer", duplicate: "warn" },
    { refType: "po" },
    { refType: "contract" },
  ]),
  doc("EST", "Estimate / quotation", "Finance", [
    { refType: "internal", required: true, duplicate: "block" },
    { refType: "customer", duplicate: "warn" },
    { refType: "po" },
  ]),
  doc("PMT", "Payment", "Finance", [
    { refType: "internal", required: true, duplicate: "block" },
    { refType: "external", duplicate: "warn" },
    { refType: "customer" },
    { refType: "vendor" },
  ]),
  doc("PO", "Purchase order", "Purchasing", [
    { refType: "internal", required: true, duplicate: "block" },
    { refType: "external", duplicate: "warn" },
    { refType: "vendor", duplicate: "warn" },
    { refType: "contract" },
  ]),
  doc("BILL", "Purchase bill", "Purchasing", [
    { refType: "internal", required: true, duplicate: "block" },
    { refType: "external", duplicate: "warn" },
    { refType: "vendor", required: true, duplicate: "block" },
    { refType: "po", duplicate: "warn" },
    { refType: "contract" },
  ]),
  doc("CON", "Contract", "Legal", [
    { refType: "internal", required: true, duplicate: "block" },
    { refType: "external", duplicate: "warn" },
    { refType: "customer" },
    { refType: "vendor" },
  ]),
] as const

const DOC_MAP = new Map<string, DocumentTypeDef>(DOCUMENT_TYPES.map((d) => [d.docType, d]))

export function getDocumentDef(docType: string): DocumentTypeDef | undefined {
  return DOC_MAP.get(normalizeDocType(docType))
}

/** The catalogue default config for a (document, reference) pair. */
export function defaultConfig(docType: string, refType: string): ReferenceConfig {
  const key = normalizeDocType(docType)
  const def = DOC_MAP.get(key)
  const rt = isReferenceType(refType) ? refType : "external"
  const found = def?.defaults.find((c) => c.refType === rt)
  if (found) return { ...found }
  return { docType: key, refType: rt, enabled: false, required: false, duplicate: "off" }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ConfigInput = {
  docType: string
  refType: string
  enabled?: boolean
  required?: boolean
  duplicate?: string
}

/**
 * Validate + normalize a raw config into a safe ReferenceConfig, or return the
 * collected reasons. The API and UI both funnel through here.
 */
export function validateConfigInput(
  input: ConfigInput,
): { ok: true; config: ReferenceConfig } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const docType = normalizeDocType(input.docType)
  if (!docType) errors.push("A document type is required.")

  const refType = String(input.refType ?? "")
  if (!isReferenceType(refType)) {
    errors.push(`Reference type must be one of: ${REFERENCE_TYPES.map((r) => r.type).join(", ")}.`)
  }

  const duplicate = input.duplicate == null ? "off" : String(input.duplicate)
  if (!isDuplicatePolicy(duplicate)) {
    errors.push(`Duplicate policy must be one of: ${DUPLICATE_POLICIES.join(", ")}.`)
  }

  const enabled = input.enabled !== false
  const required = input.required === true

  // A required reference must be captured — a required-but-disabled config is
  // contradictory and would make it impossible to ever save the document.
  if (required && !enabled) {
    errors.push("A required reference must also be enabled.")
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    config: {
      docType,
      refType: refType as ReferenceType,
      enabled,
      required,
      duplicate: duplicate as DuplicatePolicy,
    },
  }
}

/**
 * Validate a candidate reference value against its config. Pure: it does not
 * know about existing values (that is the duplicate lookup in the service), it
 * only enforces presence and shape.
 */
export function validateRefValue(
  config: Pick<ReferenceConfig, "enabled" | "required">,
  rawValue: string,
): { ok: true; value: string; key: string } | { ok: false; error: string } {
  const value = cleanRefValue(rawValue)
  if (!config.enabled) {
    return { ok: false, error: "This reference type is not enabled for this document." }
  }
  if (!value) {
    if (config.required) return { ok: false, error: "This reference is required." }
    return { ok: true, value: "", key: "" }
  }
  if (value.length > 120) {
    return { ok: false, error: "Reference must be 120 characters or fewer." }
  }
  return { ok: true, value, key: duplicateKey(value) }
}
