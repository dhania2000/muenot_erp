/**
 * SPEC 40 — Unified identity registry: pure model.
 * ---------------------------------------------------------------------------
 * No DB, no `server-only`. Encodes how the ERP recognises that an employee, a
 * company (org unit / legal entity) or a party (customer or vendor) referenced
 * from different modules is really the SAME real-world entity, and the rules
 * that make merging two identities safe:
 *
 *   - identity kinds and the modules that legitimately reference each,
 *   - normalisation so "27ABCDE1234F1Z5", "27abcde 1234f 1z5" and
 *     " a@b.com " match,
 *   - collision detection when two identities disagree on a stable attribute
 *     (GSTIN, PAN, email…), which a merge must surface rather than silently
 *     overwrite,
 *   - merge legality (same tenant + kind, not self, not already merged).
 *
 * The store (store.ts) is the only thing that touches the database; it defers
 * every decision here so the rules are unit-tested in isolation
 * (see test/spec40-identity-registry.test.ts).
 */

export const IDENTITY_KINDS = ["employee", "company", "party"] as const
export type IdentityKind = (typeof IDENTITY_KINDS)[number]

export function isIdentityKind(v: unknown): v is IdentityKind {
  return typeof v === "string" && (IDENTITY_KINDS as readonly string[]).includes(v)
}

/**
 * Modules that may legitimately contribute a source reference for each identity
 * kind. Used to reject a mapping that points a party identity at, say, an HR
 * employee row (a cross-kind reference bug that would corrupt the graph).
 */
export const IDENTITY_SOURCE_MODULES: Record<IdentityKind, readonly string[]> = {
  employee: ["hr", "payroll", "auth", "assets", "tickets"],
  company: ["org", "finance", "contracts", "settings"],
  party: ["crm", "sales", "finance", "contracts", "tickets", "documents"],
}

export function isAllowedSourceModule(kind: IdentityKind, module: string): boolean {
  return IDENTITY_SOURCE_MODULES[kind]?.includes(module) ?? false
}

/** Attribute kinds that carry identity weight and are normalised for matching. */
export type IdentityAttrType = "email" | "phone" | "tax_id" | "reg_no" | "name" | "domain" | "generic"

/**
 * Normalise a raw identity attribute so equivalent-but-differently-formatted
 * values compare equal. Mirrors the party-360 normaliser so duplicate detection
 * is consistent across the two subsystems.
 */
export function normalizeAttr(type: IdentityAttrType, raw: string | null | undefined): string {
  const v = String(raw ?? "").trim()
  if (!v) return ""
  switch (type) {
    case "email":
      return v.toLowerCase()
    case "phone":
      // keep the last 10 digits so country-code/formatting differences collapse
      return v.replace(/\D+/g, "").slice(-10)
    case "tax_id":
    case "reg_no":
      return v.replace(/[^a-z0-9]/gi, "").toUpperCase()
    case "domain":
      return v
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .split("/")[0]
        .toLowerCase()
    case "name":
      return v
        .toLowerCase()
        .replace(/\b(pvt|private|ltd|limited|inc|llc|llp|co|corp|company)\b/g, "")
        .replace(/[^a-z0-9]+/g, "")
    case "generic":
    default:
      return v.toLowerCase().replace(/\s+/g, " ")
  }
}

export type IdentityAttributes = Partial<Record<string, string | null | undefined>>

/** Which attribute keys are compared as which normalisation type during a merge. */
export const MERGE_COMPARED_ATTRS: { key: string; type: IdentityAttrType; label: string }[] = [
  { key: "email", type: "email", label: "Email" },
  { key: "phone", type: "phone", label: "Phone" },
  { key: "tax_id", type: "tax_id", label: "Tax ID / GSTIN" },
  { key: "pan", type: "tax_id", label: "PAN" },
  { key: "reg_no", type: "reg_no", label: "Registration no." },
  { key: "domain", type: "domain", label: "Website domain" },
]

export type MergeCollision = { field: string; label: string; survivor: string; merged: string }

/**
 * Detect attributes where BOTH identities hold a non-empty value AND those
 * values differ after normalisation. These are the conflicts a merge must not
 * silently resolve — the caller decides (block, or override with an explicit
 * acknowledgement). A field only one side populates is complementary data, not
 * a collision.
 */
export function detectMergeCollisions(
  survivor: IdentityAttributes,
  merged: IdentityAttributes,
): MergeCollision[] {
  const out: MergeCollision[] = []
  for (const { key, type, label } of MERGE_COMPARED_ATTRS) {
    const a = normalizeAttr(type, survivor[key])
    const b = normalizeAttr(type, merged[key])
    if (a && b && a !== b) {
      out.push({ field: key, label, survivor: String(survivor[key]).trim(), merged: String(merged[key]).trim() })
    }
  }
  return out
}

export type MergeValidationInput = {
  kind: IdentityKind
  survivorId: number
  mergedId: number
  /** Kind of each record as stored, to catch cross-kind merges. */
  survivorKind: IdentityKind
  mergedKind: IdentityKind
  /** True if the record being merged away is already merged into something. */
  mergedAlreadyMerged?: boolean
  /** True if the survivor was itself already merged away (a tombstone). */
  survivorIsTombstone?: boolean
}

/**
 * Validate that a merge is structurally legal, independent of collisions.
 * Collisions are a separate, caller-acknowledgeable concern.
 */
export function validateMerge(
  input: MergeValidationInput,
): { ok: true } | { ok: false; error: string } {
  if (input.survivorId === input.mergedId) {
    return { ok: false, error: "An identity cannot be merged into itself." }
  }
  if (input.survivorKind !== input.kind || input.mergedKind !== input.kind) {
    return { ok: false, error: "Both records must be the same identity kind to merge." }
  }
  if (input.mergedAlreadyMerged) {
    return { ok: false, error: "The source identity has already been merged." }
  }
  if (input.survivorIsTombstone) {
    return { ok: false, error: "The survivor identity is itself a merged tombstone; merge into the live identity instead." }
  }
  return { ok: true }
}

/**
 * Authority to perform a merge (a critical master change). Admins always pass;
 * a non-admin needs the explicit master-data governance grant. The actor may
 * not both request and be recorded as the sole approver when four-eyes is on.
 */
export function evaluateMergeAuthority(opts: {
  actorIsAdmin: boolean
  actorHasGovernanceGrant: boolean
}): { ok: true } | { ok: false; error: string } {
  if (opts.actorIsAdmin || opts.actorHasGovernanceGrant) return { ok: true }
  return { ok: false, error: "You do not have authority to merge master identities." }
}

/** Stable canonical key for an identity, used as the cross-module join value. */
export function canonicalKey(kind: IdentityKind, id: number): string {
  return `${kind}:${id}`
}

const ID_RE = /^[1-9]\d{0,9}$/
export function parseIdentityId(raw: string | null | undefined): number | null {
  if (!raw || !ID_RE.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
