/**
 * SPEC 103 — Duplicate Detection: pure model (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * A single, reusable fuzzy-matching framework so that every master and record
 * type — Customers, Vendors, Employees, Leads, Contacts, Documents and generic
 * Masters — detects "this looks like something we already have" the SAME way,
 * instead of each module inventing its own ad-hoc string compare.
 *
 * It is entirely DATA-DRIVEN and DB-free: a module names the fields that make a
 * record "the same" and how heavily each matters (an EntityMatchConfig), and the
 * engine normalizes, compares (exact / fuzzy / phonetic-ish / email / phone /
 * name / tax-id), scores and classifies a candidate against a target. No
 * "server-only" marker: the SAME logic can pre-warn in the browser as a user
 * types and authoritatively block on the server, and is exhaustively unit-tested
 * (see test/duplicate-detection-model.test.ts).
 *
 * The service layer (service.ts) is the only part that touches the DB: it
 * fetches candidate rows and persists the review / merge workflow.
 */

// ---------------------------------------------------------------------------
// Entities that participate
// ---------------------------------------------------------------------------

export type DuplicateEntity = "customer" | "vendor" | "employee" | "lead" | "contact" | "document" | "master"

export type RecordData = Record<string, unknown>

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  if (value == null) return ""
  return typeof value === "string" ? value : String(value)
}

/** Lowercase, strip accents, collapse whitespace, drop most punctuation. */
export function normalizeText(value: unknown): string {
  return str(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Common company/legal suffixes stripped so "Acme Pvt Ltd" ≈ "Acme". */
const COMPANY_SUFFIXES = new Set([
  "pvt", "private", "ltd", "limited", "llp", "llc", "inc", "incorporated", "corp", "corporation",
  "co", "company", "gmbh", "sa", "srl", "bv", "plc", "and", "the", "group", "holdings", "enterprises",
  "solutions", "services", "technologies", "technology", "industries", "international", "global",
])

/** Normalize an organization / person name for matching. */
export function normalizeName(value: unknown): string {
  const tokens = normalizeText(value).split(" ").filter((t) => t && !COMPANY_SUFFIXES.has(t))
  return tokens.join(" ").trim()
}

/** Lowercase + trim an email; fold Gmail dots and +tags so aliases collide. */
export function normalizeEmail(value: unknown): string {
  const raw = str(value).trim().toLowerCase()
  const at = raw.lastIndexOf("@")
  if (at <= 0) return raw
  let local = raw.slice(0, at)
  const domain = raw.slice(at + 1)
  const plus = local.indexOf("+")
  if (plus >= 0) local = local.slice(0, plus)
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replace(/\./g, "")
  return `${local}@${domain}`
}

/** Digits only, keeping the last 10 (drops country/trunk prefixes for IN/US). */
export function normalizePhone(value: unknown): string {
  const digits = str(value).replace(/\D/g, "")
  return digits.length > 10 ? digits.slice(-10) : digits
}

/** Uppercase alphanumerics — for tax ids / registration numbers (PAN, GSTIN). */
export function normalizeTaxId(value: unknown): string {
  return str(value).toUpperCase().replace(/[^A-Z0-9]/g, "")
}

// ---------------------------------------------------------------------------
// Similarity algorithms (all return 0..1)
// ---------------------------------------------------------------------------

/** Classic Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Array(b.length + 1)
  let curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/** Edit-distance similarity as a 0..1 ratio. */
export function levenshteinRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - levenshtein(a, b) / max
}

/** Jaro–Winkler similarity — strong for short strings & typos, favors prefixes. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatches = new Array(a.length).fill(false)
  const bMatches = new Array(b.length).fill(false)
  let matches = 0

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow)
    const end = Math.min(i + matchWindow + 1, b.length)
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = true
      bMatches[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0

  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  transpositions /= 2

  const m = matches
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3

  // Winkler prefix boost (up to 4 chars, scaling factor 0.1).
  let prefix = 0
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** Order-independent token overlap (Jaccard-ish), good for reordered names. */
export function tokenSetRatio(a: string, b: string): number {
  const at = new Set(a.split(" ").filter(Boolean))
  const bt = new Set(b.split(" ").filter(Boolean))
  if (!at.size && !bt.size) return 1
  if (!at.size || !bt.size) return 0
  let inter = 0
  for (const t of at) if (bt.has(t)) inter++
  const union = at.size + bt.size - inter
  return union === 0 ? 1 : inter / union
}

/** Blended name similarity: the better of token-overlap and Jaro–Winkler. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na && !nb) return 1
  if (!na || !nb) return 0
  if (na === nb) return 1
  return Math.max(tokenSetRatio(na, nb), jaroWinkler(na, nb))
}

// ---------------------------------------------------------------------------
// Field matchers + entity configs
// ---------------------------------------------------------------------------

export type MatchStrategy = "exact" | "normalized" | "fuzzy" | "email" | "phone" | "name" | "taxid"

export type FieldMatcher = {
  field: string
  strategy: MatchStrategy
  /** Relative importance; the weighted mean over PRESENT fields is the score. */
  weight: number
  /** For fuzzy/name: similarity at/above this counts the field as "matched" (0..1). */
  threshold?: number
  /**
   * A hard key: when both records have this field and it matches exactly
   * (normalized), it's an immediate strong duplicate signal regardless of the
   * rest (e.g. identical GSTIN, email or employee code).
   */
  hard?: boolean
}

export type DuplicateClassification = "exact" | "strong" | "possible" | "none"

export type EntityMatchConfig = {
  entity: DuplicateEntity
  label: string
  matchers: FieldMatcher[]
  /** Weighted score at/above this => "strong" (likely the same record). */
  strongThreshold: number
  /** …and at/above this (but below strong) => "possible". */
  possibleThreshold: number
}

const DEFAULT_FUZZY_THRESHOLD = 0.82

/** Sensible built-in configs; a caller may override any of these. */
export const ENTITY_CONFIGS: Record<DuplicateEntity, EntityMatchConfig> = {
  customer: {
    entity: "customer",
    label: "Customer",
    strongThreshold: 0.8,
    possibleThreshold: 0.55,
    matchers: [
      { field: "gstin", strategy: "taxid", weight: 3, hard: true },
      { field: "email", strategy: "email", weight: 2.5, hard: true },
      { field: "phone", strategy: "phone", weight: 2, hard: true },
      { field: "name", strategy: "name", weight: 3, threshold: 0.85 },
      { field: "city", strategy: "normalized", weight: 0.5 },
    ],
  },
  vendor: {
    entity: "vendor",
    label: "Vendor",
    strongThreshold: 0.8,
    possibleThreshold: 0.55,
    matchers: [
      { field: "gstin", strategy: "taxid", weight: 3, hard: true },
      { field: "pan", strategy: "taxid", weight: 2.5, hard: true },
      { field: "email", strategy: "email", weight: 2, hard: true },
      { field: "name", strategy: "name", weight: 3, threshold: 0.85 },
    ],
  },
  employee: {
    entity: "employee",
    label: "Employee",
    strongThreshold: 0.82,
    possibleThreshold: 0.6,
    matchers: [
      { field: "employeeCode", strategy: "exact", weight: 3, hard: true },
      { field: "email", strategy: "email", weight: 2.5, hard: true },
      { field: "pan", strategy: "taxid", weight: 2.5, hard: true },
      { field: "phone", strategy: "phone", weight: 1.5, hard: true },
      { field: "name", strategy: "name", weight: 2.5, threshold: 0.85 },
      { field: "dateOfBirth", strategy: "exact", weight: 1 },
    ],
  },
  lead: {
    entity: "lead",
    label: "Lead",
    strongThreshold: 0.75,
    possibleThreshold: 0.5,
    matchers: [
      { field: "email", strategy: "email", weight: 3, hard: true },
      { field: "phone", strategy: "phone", weight: 2.5, hard: true },
      { field: "company", strategy: "name", weight: 2, threshold: 0.85 },
      { field: "name", strategy: "name", weight: 2, threshold: 0.85 },
    ],
  },
  contact: {
    entity: "contact",
    label: "Contact",
    strongThreshold: 0.78,
    possibleThreshold: 0.5,
    matchers: [
      { field: "email", strategy: "email", weight: 3, hard: true },
      { field: "phone", strategy: "phone", weight: 2.5, hard: true },
      { field: "name", strategy: "name", weight: 2.5, threshold: 0.85 },
    ],
  },
  document: {
    entity: "document",
    label: "Document",
    strongThreshold: 0.85,
    possibleThreshold: 0.6,
    matchers: [
      { field: "hash", strategy: "exact", weight: 4, hard: true },
      { field: "documentNumber", strategy: "normalized", weight: 3, hard: true },
      { field: "title", strategy: "fuzzy", weight: 2, threshold: 0.9 },
    ],
  },
  master: {
    entity: "master",
    label: "Master record",
    strongThreshold: 0.85,
    possibleThreshold: 0.6,
    matchers: [
      { field: "code", strategy: "exact", weight: 3, hard: true },
      { field: "name", strategy: "name", weight: 3, threshold: 0.88 },
    ],
  },
}

export function getEntityConfig(entity: DuplicateEntity): EntityMatchConfig {
  return ENTITY_CONFIGS[entity]
}

// ---------------------------------------------------------------------------
// Per-field similarity
// ---------------------------------------------------------------------------

/** Compute a 0..1 similarity for a single matcher's field across two records. */
export function fieldSimilarity(matcher: FieldMatcher, a: unknown, b: unknown): number {
  switch (matcher.strategy) {
    case "exact":
      return normalizeText(a) !== "" && normalizeText(a) === normalizeText(b) ? 1 : 0
    case "normalized":
      return normalizeText(a) !== "" && normalizeText(a) === normalizeText(b) ? 1 : 0
    case "email": {
      const na = normalizeEmail(a)
      const nb = normalizeEmail(b)
      return na !== "" && na === nb ? 1 : 0
    }
    case "phone": {
      const na = normalizePhone(a)
      const nb = normalizePhone(b)
      return na.length >= 7 && na === nb ? 1 : 0
    }
    case "taxid": {
      const na = normalizeTaxId(a)
      const nb = normalizeTaxId(b)
      return na !== "" && na === nb ? 1 : 0
    }
    case "name":
      return nameSimilarity(String(a ?? ""), String(b ?? ""))
    case "fuzzy": {
      const na = normalizeText(a)
      const nb = normalizeText(b)
      if (!na || !nb) return na === nb ? 1 : 0
      return Math.max(levenshteinRatio(na, nb), jaroWinkler(na, nb))
    }
  }
}

function thresholdFor(matcher: FieldMatcher): number {
  if (matcher.threshold != null) return matcher.threshold
  return matcher.strategy === "name" || matcher.strategy === "fuzzy" ? DEFAULT_FUZZY_THRESHOLD : 1
}

function isPresent(value: unknown): boolean {
  return value != null && str(value).trim() !== ""
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

export type FieldScore = { field: string; similarity: number; matched: boolean; weight: number; hard: boolean }

export type MatchScore = {
  score: number
  classification: DuplicateClassification
  matchedFields: string[]
  hardMatch: boolean
  fieldScores: FieldScore[]
}

/**
 * Score a candidate against a target using an entity config. The score is the
 * weighted mean of similarity over the fields BOTH records populate, so absent
 * data neither helps nor hurts. Any exact "hard key" match (email, GSTIN,
 * employee code, document hash, …) short-circuits to at least "strong".
 */
export function scoreCandidate(
  config: EntityMatchConfig,
  target: RecordData,
  candidate: RecordData,
): MatchScore {
  const fieldScores: FieldScore[] = []
  let weightSum = 0
  let weightedSim = 0
  let hardMatch = false

  for (const matcher of config.matchers) {
    const a = target[matcher.field]
    const b = candidate[matcher.field]
    // A field only participates when BOTH records populate it.
    if (!isPresent(a) || !isPresent(b)) continue
    const similarity = fieldSimilarity(matcher, a, b)
    const matched = similarity >= thresholdFor(matcher)
    if (matched && matcher.hard) hardMatch = true
    fieldScores.push({ field: matcher.field, similarity, matched, weight: matcher.weight, hard: !!matcher.hard })
    weightSum += matcher.weight
    weightedSim += matcher.weight * similarity
  }

  const rawScore = weightSum > 0 ? weightedSim / weightSum : 0
  // A hard-key exact match is authoritative even if other fields differ.
  const score = hardMatch ? Math.max(rawScore, config.strongThreshold) : rawScore

  const matchedFields = fieldScores.filter((f) => f.matched).map((f) => f.field)
  const classification = classifyScore(config, score, hardMatch)

  return { score: round(score), classification, matchedFields, hardMatch, fieldScores }
}

export function classifyScore(
  config: EntityMatchConfig,
  score: number,
  hardMatch: boolean,
): DuplicateClassification {
  if (hardMatch && score >= config.strongThreshold) return score >= 0.99 ? "exact" : "strong"
  if (score >= 0.999) return "exact"
  if (score >= config.strongThreshold) return "strong"
  if (score >= config.possibleThreshold) return "possible"
  return "none"
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ---------------------------------------------------------------------------
// Ranking candidates
// ---------------------------------------------------------------------------

export type CandidateWithId = RecordData & { id: string | number }

export type DuplicateMatch<T extends CandidateWithId = CandidateWithId> = {
  candidate: T
  score: number
  classification: DuplicateClassification
  matchedFields: string[]
  hardMatch: boolean
}

export type FindMatchesOptions = {
  /** Lowest classification to include (default "possible"). */
  minClassification?: DuplicateClassification
  /** Cap the number of returned matches (default 25). */
  limit?: number
  /** Exclude this id (a record never matches itself on update). */
  excludeId?: string | number | null
}

const CLASS_RANK: Record<DuplicateClassification, number> = { none: 0, possible: 1, strong: 2, exact: 3 }

/** Score every candidate, drop the weak ones, and return the strongest first. */
export function findDuplicateMatches<T extends CandidateWithId>(
  config: EntityMatchConfig,
  target: RecordData,
  candidates: readonly T[],
  options: FindMatchesOptions = {},
): DuplicateMatch<T>[] {
  const min = CLASS_RANK[options.minClassification ?? "possible"]
  const limit = options.limit ?? 25
  const out: DuplicateMatch<T>[] = []

  for (const candidate of candidates) {
    if (options.excludeId != null && String(candidate.id) === String(options.excludeId)) continue
    const s = scoreCandidate(config, target, candidate)
    if (CLASS_RANK[s.classification] < min) continue
    out.push({
      candidate,
      score: s.score,
      classification: s.classification,
      matchedFields: s.matchedFields,
      hardMatch: s.hardMatch,
    })
  }

  out.sort((a, b) => b.score - a.score || CLASS_RANK[b.classification] - CLASS_RANK[a.classification])
  return out.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Merge planning (the "review & merge" workflow, pure part)
// ---------------------------------------------------------------------------

export type MergeStrategy =
  | "preferPrimary" // primary wins unless it's blank, then take secondary
  | "preferSecondary" // secondary wins unless it's blank, then take primary
  | "keepPrimary" // always primary, even if blank
  | "keepSecondary" // always secondary, even if blank

export type MergeResolution = { value: unknown; from: "primary" | "secondary" }

export type MergePlan = {
  fields: Record<string, MergeResolution>
  /** Fields where primary and secondary disagree (both present, not equal). */
  conflicts: string[]
}

/**
 * Produce a field-by-field merge plan of two records. `overrides` lets a
 * reviewer pin specific fields to a chosen source; everything else follows the
 * default strategy. The plan is DATA — the service applies it transactionally.
 */
export function planMerge(
  primary: RecordData,
  secondary: RecordData,
  options: { fields?: string[]; strategy?: MergeStrategy; overrides?: Record<string, "primary" | "secondary"> } = {},
): MergePlan {
  const strategy = options.strategy ?? "preferPrimary"
  const keys = options.fields ?? [...new Set([...Object.keys(primary), ...Object.keys(secondary)])]
  const fields: Record<string, MergeResolution> = {}
  const conflicts: string[] = []

  for (const key of keys) {
    const p = primary[key]
    const s = secondary[key]
    const pPresent = isPresent(p)
    const sPresent = isPresent(s)
    if (pPresent && sPresent && normalizeText(p) !== normalizeText(s)) conflicts.push(key)

    const override = options.overrides?.[key]
    if (override) {
      fields[key] = { value: override === "primary" ? p : s, from: override }
      continue
    }

    switch (strategy) {
      case "keepPrimary":
        fields[key] = { value: p, from: "primary" }
        break
      case "keepSecondary":
        fields[key] = { value: s, from: "secondary" }
        break
      case "preferSecondary":
        fields[key] = sPresent ? { value: s, from: "secondary" } : { value: p, from: "primary" }
        break
      case "preferPrimary":
      default:
        fields[key] = pPresent ? { value: p, from: "primary" } : { value: s, from: "secondary" }
        break
    }
  }

  return { fields, conflicts }
}

/** Flatten a merge plan into the plain record you'd persist. */
export function applyMergePlan(plan: MergePlan): RecordData {
  const out: RecordData = {}
  for (const [key, res] of Object.entries(plan.fields)) out[key] = res.value
  return out
}
