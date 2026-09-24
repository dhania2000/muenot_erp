import { describe, it, expect } from "vitest"
import {
  buildContactColumns,
  CONTACT_MATCH_CONFIG,
  displayNameOf,
  findContactDuplicateMatches,
  fullNameOf,
  isValidEmail,
  normalizeEmail,
  normalizeGstin,
  normalizePan,
  normalizePhone,
  panFromGstin,
  sanitizeAddresses,
  sanitizeChannels,
  sanitizeEmails,
  sanitizePhones,
  splitName,
  toBool,
  toMatchRecord,
  validateContact,
  type CandidateWithId,
} from "@/lib/contacts/model"

/**
 * SPEC 108 Phase 4 — test duplicate handling (and the pure model it rests on).
 *
 * The centralized `contacts` record is the single source of truth for a
 * person/company across CRM, Finance (customer/vendor) and the Sales/Marketing
 * modules, so it MUST never silently create a second row for someone who is
 * already stored, and MUST never fuse two genuinely different parties. Those
 * decisions come entirely from the pure functions here (no DB / server-only
 * imports): the normalizers, the request→column builder, the child-collection
 * sanitizers, validation, and the duplicate scoring built on the SPEC 103
 * framework. Pinning them means a regression is caught here, not in production.
 */

// ---------------------------------------------------------------------------
// Field normalizers
// ---------------------------------------------------------------------------

describe("normalizers", () => {
  it("normalizeEmail trims + lowercases, blank -> null", () => {
    expect(normalizeEmail("  John.Doe@Acme.COM ")).toBe("john.doe@acme.com")
    expect(normalizeEmail("")).toBeNull()
    expect(normalizeEmail("   ")).toBeNull()
    expect(normalizeEmail(null)).toBeNull()
  })

  it("isValidEmail accepts a real address and rejects junk", () => {
    expect(isValidEmail("ops@acme.com")).toBe(true)
    expect(isValidEmail("no-at-sign")).toBe(false)
    expect(isValidEmail("missing@domain")).toBe(false)
    expect(isValidEmail("has space@acme.com")).toBe(false)
  })

  it("normalizePhone keeps a leading + then digits only, blank -> null", () => {
    expect(normalizePhone("+91 98877-66554")).toBe("+919887766554")
    expect(normalizePhone("(080) 4123 4123")).toBe("08041234123")
    expect(normalizePhone("n/a")).toBeNull()
    expect(normalizePhone("")).toBeNull()
  })

  it("normalizeGstin / normalizePan uppercase and strip whitespace", () => {
    expect(normalizeGstin(" 22abcde1234f 1z5 ")).toBe("22ABCDE1234F1Z5")
    expect(normalizePan(" abcde1234f ")).toBe("ABCDE1234F")
    expect(normalizeGstin("")).toBeNull()
  })

  it("panFromGstin extracts the embedded PAN only when valid", () => {
    expect(panFromGstin("22ABCDE1234F1Z5")).toBe("ABCDE1234F")
    expect(panFromGstin("short")).toBeNull()
    expect(panFromGstin(null)).toBeNull()
  })

  it("toBool reads the usual truthy encodings", () => {
    expect(toBool(true)).toBe(true)
    expect(toBool("yes")).toBe(true)
    expect(toBool("on")).toBe(true)
    expect(toBool(1)).toBe(true)
    expect(toBool("false")).toBe(false)
    expect(toBool("0")).toBe(false)
    expect(toBool(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

describe("name helpers", () => {
  it("fullNameOf joins and trims", () => {
    expect(fullNameOf("John", "Doe")).toBe("John Doe")
    expect(fullNameOf("  ", "Doe")).toBe("Doe")
    expect(fullNameOf("", "")).toBe("")
  })

  it("splitName splits first vs the rest", () => {
    expect(splitName("John")).toEqual({ first: "John", last: "" })
    expect(splitName("John Doe")).toEqual({ first: "John", last: "Doe" })
    expect(splitName("John Van Der Berg")).toEqual({ first: "John", last: "Van Der Berg" })
    expect(splitName("   ")).toEqual({ first: "", last: "" })
  })

  it("displayNameOf prefers company for a Company and full name for a Person", () => {
    expect(displayNameOf({ contact_type: "Company", company_name: "Acme Inc", first_name: "Jane" })).toBe("Acme Inc")
    expect(displayNameOf({ contact_type: "Person", first_name: "Jane", last_name: "Roe" })).toBe("Jane Roe")
    // Never blank: falls back to email then a placeholder.
    expect(displayNameOf({ contact_type: "Person", email: "jane@acme.com" })).toBe("jane@acme.com")
    expect(displayNameOf({ contact_type: "Person" })).toBe("Untitled contact")
  })
})

// ---------------------------------------------------------------------------
// Request -> server-owned columns
// ---------------------------------------------------------------------------

describe("buildContactColumns", () => {
  it("derives full_name, normalized keys and boolean flags for a Person", () => {
    const cols = buildContactColumns({
      contact_type: "Person",
      first_name: "Jon",
      last_name: "Smith",
      email: "Jon.Smith+news@Gmail.com",
      phone: "+91 98877-66554",
      is_customer: "yes",
      is_vendor: 0,
      role: "  Buyer  ",
      department: "Procurement",
    })
    expect(cols.contact_type).toBe("Person")
    expect(cols.full_name).toBe("Jon Smith")
    expect(cols.email).toBe("jon.smith+news@gmail.com")
    // email_normalized uses the dedupe normalizer (folds gmail dots + tag).
    expect(cols.email_normalized).toBe("jonsmith@gmail.com")
    expect(cols.phone).toBe("+919887766554")
    expect(cols.phone_normalized).toBe("9887766554")
    expect(cols.is_customer).toBe(1)
    expect(cols.is_vendor).toBe(0)
    expect(cols.role).toBe("Buyer")
    expect(cols.status).toBe("Active")
  })

  it("uses company_name as full_name for a Company and derives PAN from GSTIN", () => {
    const cols = buildContactColumns({
      contact_type: "Company",
      company_name: "Acme Industries",
      gstin: "22abcde1234f1z5",
    })
    expect(cols.contact_type).toBe("Company")
    expect(cols.full_name).toBe("Acme Industries")
    expect(cols.gstin).toBe("22ABCDE1234F1Z5")
    expect(cols.pan).toBe("ABCDE1234F")
  })

  it("never leaves full_name blank", () => {
    expect(buildContactColumns({ contact_type: "Person" }).full_name).toBe("Untitled contact")
  })

  it("normalizes module link ids (positive int, else null)", () => {
    const cols = buildContactColumns({
      contact_type: "Person",
      first_name: "A",
      client_id: "42",
      sales_company_id: "0",
      finance_party_id: " CV-1001 ",
    })
    expect(cols.client_id).toBe(42)
    expect(cols.sales_company_id).toBeNull()
    expect(cols.finance_party_id).toBe("CV-1001")
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateContact", () => {
  it("requires a company name for a Company", () => {
    expect(validateContact({ contact_type: "Company" })).toHaveProperty("company_name")
    expect(validateContact({ contact_type: "Company", company_name: "Acme" })).toEqual({})
  })

  it("requires a first or last name for a Person", () => {
    expect(validateContact({ contact_type: "Person" })).toHaveProperty("first_name")
    expect(validateContact({ contact_type: "Person", last_name: "Roe" })).toEqual({})
  })

  it("rejects an invalid primary email and invalid additional emails", () => {
    expect(validateContact({ contact_type: "Person", first_name: "A", email: "bad" })).toHaveProperty("email")
    expect(
      validateContact({ contact_type: "Person", first_name: "A", emails: ["ok@acme.com", "nope"] }),
    ).toHaveProperty("emails")
  })
})

// ---------------------------------------------------------------------------
// Child collections (emails / phones / channels / addresses)
// ---------------------------------------------------------------------------

describe("sanitizeEmails", () => {
  it("drops invalids, dedupes by normalized form and guarantees one primary", () => {
    const out = sanitizeEmails([
      "Jon.Smith@Gmail.com",
      { email: "jonsmith@gmail.com" }, // duplicate after normalization
      "invalid",
      { email: "billing@acme.com", label: "Billing", is_primary: true },
    ])
    expect(out).toHaveLength(2)
    expect(out.filter((e) => e.is_primary)).toHaveLength(1)
    expect(out.find((e) => e.is_primary)?.email).toBe("billing@acme.com")
  })

  it("promotes the first email to primary when none is flagged", () => {
    const out = sanitizeEmails(["a@acme.com", "b@acme.com"])
    expect(out[0].is_primary).toBe(true)
    expect(out[1].is_primary).toBe(false)
  })

  it("returns [] for non-arrays", () => {
    expect(sanitizeEmails(undefined)).toEqual([])
    expect(sanitizeEmails("a@acme.com")).toEqual([])
  })
})

describe("sanitizePhones", () => {
  it("dedupes by normalized number and keeps a single primary", () => {
    const out = sanitizePhones([
      { phone: "+91 98877-66554", label: "Work" },
      { phone: "098877 66554" }, // same last-10 digits -> duplicate
      { phone: "+1 (415) 555-0100", is_primary: true },
    ])
    expect(out).toHaveLength(2)
    expect(out.filter((p) => p.is_primary)).toHaveLength(1)
  })
})

describe("sanitizeChannels", () => {
  it("keeps values, validates the channel type and falls back to Other", () => {
    const out = sanitizeChannels([
      { channel_type: "LinkedIn", value: "in/jonsmith" },
      { channel_type: "Myspace", value: "jon" }, // unknown -> Other
      { channel_type: "Twitter", value: "" }, // blank value dropped
    ])
    expect(out).toHaveLength(2)
    expect(out[0].channel_type).toBe("LinkedIn")
    expect(out[1].channel_type).toBe("Other")
  })
})

describe("sanitizeAddresses", () => {
  it("keeps addresses with any field, validates the type and ensures one primary", () => {
    const out = sanitizeAddresses([
      { address_type: "Billing", line1: "1 Main St", city: "Bengaluru" },
      { address_type: "Nowhere", city: "Mumbai" }, // unknown type -> Other
      { line1: "", city: "", state: "" }, // entirely blank -> dropped
    ])
    expect(out).toHaveLength(2)
    expect(out[0].address_type).toBe("Billing")
    expect(out[1].address_type).toBe("Other")
    expect(out.filter((a) => a.is_primary)).toHaveLength(1)
    expect(out[0].is_primary).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Duplicate handling — the heart of Phase 4
// ---------------------------------------------------------------------------

describe("toMatchRecord", () => {
  it("maps a contact row/body into the match config's fields", () => {
    expect(
      toMatchRecord({ full_name: "Jon Smith", company_name: "Acme", email: "j@acme.com", gstin: "22ABCDE1234F1Z5" }),
    ).toEqual({ name: "Jon Smith", company: "Acme", email: "j@acme.com", phone: null, gstin: "22ABCDE1234F1Z5", pan: null })
  })

  it("builds the name from first/last when full_name is absent", () => {
    expect(toMatchRecord({ first_name: "Jon", last_name: "Smith" }).name).toBe("Jon Smith")
  })
})

describe("CONTACT_MATCH_CONFIG", () => {
  it("treats email, phone, gstin and pan as hard keys", () => {
    const hard = CONTACT_MATCH_CONFIG.matchers.filter((m) => m.hard).map((m) => m.field).sort()
    expect(hard).toEqual(["email", "gstin", "pan", "phone"])
  })
})

describe("findContactDuplicateMatches", () => {
  // Candidates arrive pre-mapped into the config's field names (name/company/…),
  // exactly as lib/contacts/db.ts hands them to the model.
  const candidates: CandidateWithId[] = [
    { id: 1, name: "Jon Smith", company: null, email: "jon.smith@acme.com", phone: null, gstin: null, pan: null },
    { id: 2, name: "Jonathan Smith", company: null, email: null, phone: "9887766554", gstin: null, pan: null },
    { id: 3, name: "Alice Brown", company: "Globex", email: "alice@globex.com", phone: null, gstin: null, pan: null },
    { id: 4, name: "Jonathon Smyth", company: null, email: null, phone: null, gstin: null, pan: null },
  ]

  it("flags an existing person by a shared email regardless of name spelling", () => {
    const target = { full_name: "J. Smith", email: "Jon.Smith@Acme.com" }
    const matches = findContactDuplicateMatches(target, candidates)
    expect(matches[0].candidate.id).toBe(1)
    expect(["strong", "exact"]).toContain(matches[0].classification)
    expect(matches[0].matchedFields).toContain("email")
  })

  it("flags a company by GSTIN even when the display name differs", () => {
    const target = { contact_type: "Company", company_name: "Acme Industries Pvt Ltd", full_name: "Acme Industries Pvt Ltd", gstin: "22ABCDE1234F1Z5" }
    const withGstin: CandidateWithId[] = [
      { id: 10, name: "Totally Different Traders", company: "Totally Different Traders", email: null, phone: null, gstin: "22ABCDE1234F1Z5", pan: null },
      { id: 11, name: "Unrelated Co", company: "Unrelated Co", email: null, phone: null, gstin: "09ZZZZZ9999Z9Z9", pan: null },
    ]
    const matches = findContactDuplicateMatches(target, withGstin)
    expect(matches.map((m) => m.candidate.id)).toContain(10)
    expect(matches.map((m) => m.candidate.id)).not.toContain(11)
    expect(matches.find((m) => m.candidate.id === 10)?.matchedFields).toContain("gstin")
  })

  it("ranks strongest first and never returns the unrelated party", () => {
    const target = { full_name: "Jonathan Smith", email: "jon.smith@acme.com", phone: "+91 98877-66554" }
    const matches = findContactDuplicateMatches(target, candidates)
    expect(matches.map((m) => m.candidate.id)).not.toContain(3)
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score)
    }
  })

  it("excludes the record itself when editing (excludeId)", () => {
    const target = { full_name: "Jon Smith", email: "jon.smith@acme.com" }
    const matches = findContactDuplicateMatches(target, candidates, { excludeId: 1 })
    expect(matches.map((m) => m.candidate.id)).not.toContain(1)
  })

  it("honors minClassification and limit", () => {
    const target = { full_name: "Jonathan Smith", email: "jon.smith@acme.com", phone: "9887766554" }
    const strong = findContactDuplicateMatches(target, candidates, { minClassification: "strong" })
    expect(strong.every((m) => m.classification === "strong" || m.classification === "exact")).toBe(true)
    const capped = findContactDuplicateMatches(target, candidates, { limit: 1 })
    expect(capped).toHaveLength(1)
  })

  it("does not invent a duplicate for a brand-new, unrelated contact", () => {
    const target = { full_name: "Priya Nair", email: "priya@newco.example", phone: "+91 90000 00001" }
    const matches = findContactDuplicateMatches(target, candidates)
    expect(matches).toHaveLength(0)
  })
})
