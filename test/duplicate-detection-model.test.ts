import { describe, it, expect } from "vitest"
import {
  applyMergePlan,
  classifyScore,
  fieldSimilarity,
  findDuplicateMatches,
  getEntityConfig,
  jaroWinkler,
  levenshtein,
  levenshteinRatio,
  nameSimilarity,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeTaxId,
  normalizeText,
  planMerge,
  scoreCandidate,
  tokenSetRatio,
  type CandidateWithId,
} from "@/lib/duplicate-detection/model"

/**
 * SPEC 103 Phase 4. Duplicate detection decides whether two records are "the
 * same", so its entire trustworthiness rests on this pure model: the
 * normalizers, the similarity algorithms, the weighted scoring/classification
 * and the merge planning. These tests pin that model (no DB / server-only
 * imports) so a regression can never silently merge two different customers or
 * miss an obvious duplicate.
 */

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

describe("normalizers", () => {
  it("normalizeText lowercases, strips punctuation and collapses spaces", () => {
    expect(normalizeText("  Açme, Inc.  ")).toBe("acme inc")
  })

  it("normalizeName drops company suffixes so the core name remains", () => {
    expect(normalizeName("Acme Private Limited")).toBe("acme")
    expect(normalizeName("The Acme Group")).toBe("acme")
    expect(normalizeName("Acme Pvt Ltd")).toBe(normalizeName("Acme"))
  })

  it("normalizeEmail folds gmail dots and +tags", () => {
    expect(normalizeEmail("John.Doe+news@Gmail.com")).toBe("johndoe@gmail.com")
    // Non-gmail keeps dots but still lowercases and strips the tag.
    expect(normalizeEmail("john.doe+x@Acme.com")).toBe("john.doe@acme.com")
  })

  it("normalizePhone keeps the last 10 digits", () => {
    expect(normalizePhone("+91 98877-66554")).toBe("9887766554")
    expect(normalizePhone("098877 66554")).toBe("9887766554")
  })

  it("normalizeTaxId uppercases and strips separators", () => {
    expect(normalizeTaxId("22abcde1234f-1z5")).toBe("22ABCDE1234F1Z5")
  })
})

// ---------------------------------------------------------------------------
// Similarity algorithms
// ---------------------------------------------------------------------------

describe("similarity algorithms", () => {
  it("levenshtein counts edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3)
    expect(levenshtein("abc", "abc")).toBe(0)
  })

  it("levenshteinRatio is 1 for identical and 0 for fully different-length", () => {
    expect(levenshteinRatio("abc", "abc")).toBe(1)
    expect(levenshteinRatio("", "")).toBe(1)
    expect(levenshteinRatio("abcd", "abce")).toBeCloseTo(0.75, 5)
  })

  it("jaroWinkler rewards shared prefixes and typos", () => {
    expect(jaroWinkler("martha", "marhta")).toBeGreaterThan(0.9)
    expect(jaroWinkler("acme", "acme")).toBe(1)
    expect(jaroWinkler("abc", "xyz")).toBe(0)
  })

  it("tokenSetRatio is order-independent", () => {
    expect(tokenSetRatio("john smith", "smith john")).toBe(1)
    expect(tokenSetRatio("a b c", "a b")).toBeCloseTo(2 / 3, 5)
  })

  it("nameSimilarity treats reordered / suffixed names as the same", () => {
    expect(nameSimilarity("Acme Pvt Ltd", "Acme")).toBe(1)
    expect(nameSimilarity("John Smith", "Smith John")).toBe(1)
    expect(nameSimilarity("Acme", "Globex")).toBeLessThan(0.5)
  })
})

// ---------------------------------------------------------------------------
// Field similarity by strategy
// ---------------------------------------------------------------------------

describe("fieldSimilarity", () => {
  it("email/phone/taxid are exact-after-normalization (1 or 0)", () => {
    expect(fieldSimilarity({ field: "email", strategy: "email", weight: 1 }, "A@B.com", "a@b.com")).toBe(1)
    expect(fieldSimilarity({ field: "phone", strategy: "phone", weight: 1 }, "+91 9887766554", "09887766554")).toBe(1)
    expect(fieldSimilarity({ field: "gstin", strategy: "taxid", weight: 1 }, "22abcde1234f1z5", "22ABCDE1234F1Z5")).toBe(1)
    expect(fieldSimilarity({ field: "email", strategy: "email", weight: 1 }, "a@b.com", "c@d.com")).toBe(0)
  })

  it("blank on either side yields 0 (never a false match)", () => {
    expect(fieldSimilarity({ field: "email", strategy: "email", weight: 1 }, "", "a@b.com")).toBe(0)
    expect(fieldSimilarity({ field: "name", strategy: "name", weight: 1 }, "Acme", "")).toBe(0)
  })

  it("short phone numbers do not match (avoids extension collisions)", () => {
    expect(fieldSimilarity({ field: "phone", strategy: "phone", weight: 1 }, "123", "123")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Candidate scoring + classification
// ---------------------------------------------------------------------------

describe("scoreCandidate", () => {
  const customer = getEntityConfig("customer")

  it("hard-key match (identical GSTIN) is at least strong even if names differ", () => {
    const s = scoreCandidate(
      customer,
      { name: "Acme Industries", gstin: "22ABCDE1234F1Z5" },
      { name: "Totally Different Co", gstin: "22ABCDE1234F1Z5" },
    )
    expect(s.hardMatch).toBe(true)
    expect(["strong", "exact"]).toContain(s.classification)
    expect(s.matchedFields).toContain("gstin")
  })

  it("close names with a shared city score as strong/possible", () => {
    const s = scoreCandidate(
      customer,
      { name: "Acme Private Limited", city: "Bengaluru" },
      { name: "Acme Pvt Ltd", city: "Bengaluru" },
    )
    expect(s.score).toBeGreaterThan(customer.possibleThreshold)
    expect(s.matchedFields).toContain("name")
  })

  it("only fields present in BOTH records count toward the score", () => {
    // Only name is shared; email present on one side is ignored, not penalized.
    const s = scoreCandidate(customer, { name: "Acme", email: "ops@acme.com" }, { name: "Acme" })
    expect(s.score).toBe(1) // name matches perfectly, nothing dilutes it
  })

  it("unrelated records classify as none", () => {
    const s = scoreCandidate(customer, { name: "Acme", city: "Bengaluru" }, { name: "Globex", city: "Mumbai" })
    expect(s.classification).toBe("none")
  })

  it("classifyScore honors entity thresholds", () => {
    expect(classifyScore(customer, 0.99, false)).toBe("strong")
    expect(classifyScore(customer, 1, false)).toBe("exact")
    expect(classifyScore(customer, 0.6, false)).toBe("possible")
    expect(classifyScore(customer, 0.1, false)).toBe("none")
  })
})

// ---------------------------------------------------------------------------
// Ranking many candidates
// ---------------------------------------------------------------------------

describe("findDuplicateMatches", () => {
  const config = getEntityConfig("contact")
  const target = { name: "Jonathan Smith", email: "jon.smith@acme.com", phone: "+91 9887766554" }
  const candidates: CandidateWithId[] = [
    { id: 1, name: "Jon Smith", email: "jon.smith@acme.com" }, // hard email match
    { id: 2, name: "Jonathan Smith", phone: "9887766554" }, // hard phone + name
    { id: 3, name: "Alice Brown", email: "alice@globex.com" }, // unrelated
    { id: 4, name: "Jonathon Smyth" }, // fuzzy name only
  ]

  it("returns strong matches first and drops the unrelated one", () => {
    const matches = findDuplicateMatches(config, target, candidates)
    const ids = matches.map((m) => m.candidate.id)
    expect(ids).not.toContain(3)
    expect(ids[0]).toBeTypeOf("number")
    // Strongest (hard-key) matches lead.
    expect([1, 2]).toContain(matches[0].candidate.id)
    // Sorted descending by score.
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score)
    }
  })

  it("excludes the record itself by id", () => {
    const matches = findDuplicateMatches(config, target, candidates, { excludeId: 1 })
    expect(matches.map((m) => m.candidate.id)).not.toContain(1)
  })

  it("respects minClassification and limit", () => {
    const strongOnly = findDuplicateMatches(config, target, candidates, { minClassification: "strong" })
    expect(strongOnly.every((m) => m.classification === "strong" || m.classification === "exact")).toBe(true)
    const capped = findDuplicateMatches(config, target, candidates, { limit: 1 })
    expect(capped).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Merge planning
// ---------------------------------------------------------------------------

describe("planMerge", () => {
  const primary = { id: 1, name: "Acme", email: "ops@acme.com", phone: "", notes: "primary note" }
  const secondary = { id: 2, name: "Acme Corp", email: "", phone: "9887766554", notes: "secondary note" }

  it("preferPrimary fills primary blanks from secondary and flags conflicts", () => {
    const plan = planMerge(primary, secondary)
    expect(plan.fields.name).toEqual({ value: "Acme", from: "primary" })
    expect(plan.fields.email).toEqual({ value: "ops@acme.com", from: "primary" })
    // primary.phone blank -> take secondary
    expect(plan.fields.phone).toEqual({ value: "9887766554", from: "secondary" })
    // both notes present and differ -> conflict
    expect(plan.conflicts).toContain("notes")
  })

  it("marks differing present values as conflicts", () => {
    const plan = planMerge(primary, secondary)
    expect(plan.conflicts).toContain("name") // Acme vs Acme Corp differ
    expect(plan.conflicts).toContain("notes")
  })

  it("overrides pin a field to a chosen source", () => {
    const plan = planMerge(primary, secondary, { overrides: { name: "secondary" } })
    expect(plan.fields.name).toEqual({ value: "Acme Corp", from: "secondary" })
  })

  it("keepPrimary/keepSecondary ignore blanks", () => {
    const kp = planMerge(primary, secondary, { strategy: "keepPrimary" })
    expect(kp.fields.phone).toEqual({ value: "", from: "primary" })
    const ks = planMerge(primary, secondary, { strategy: "keepSecondary" })
    expect(ks.fields.email).toEqual({ value: "", from: "secondary" })
  })

  it("applyMergePlan flattens to a plain record", () => {
    const plan = planMerge(primary, secondary, { fields: ["name", "email", "phone"] })
    expect(applyMergePlan(plan)).toEqual({ name: "Acme", email: "ops@acme.com", phone: "9887766554" })
  })
})
