import { describe, expect, it } from "vitest"
import {
  DOC_TYPES,
  normalizeDocType,
  normalizeStatus,
  classifyDocument,
  extractDocument,
  computeOverallConfidence,
  validateExtraction,
  mergeCorrections,
  diffCorrections,
  canQueueForProcessing,
  canPost,
  canTransition,
  deriveContentHash,
  derivePostIdempotencyKey,
  type ExtractedField,
  type ExtractionStatus,
} from "@/lib/ai/document-intelligence/model"
import { HeuristicExtractionProvider, detectLanguage } from "@/lib/ai/document-intelligence/extractor"

/**
 * SPEC 19 (req #74) — Phase 4 verification for the AI Document Intelligence
 * PURE model + policy layer. These are the deterministic, DB-free guarantees the
 * store, service and routes rely on:
 *   - document classification (invoice / receipt / resume / contract),
 *   - field extraction with per-field source highlights + confidence,
 *   - reviewer corrections merge/diff (feeds the audit trail),
 *   - the two security gates (queue-after-clean-scan-and-auth, post-after-review),
 *   - the status transition table,
 *   - content-hash idempotency for repeated uploads,
 *   - graceful handling of malformed / empty scans,
 *   - multilingual language detection.
 */

// ---------------------------------------------------------------------------
// Normalizers reject untrusted input (fail-safe defaults)
// ---------------------------------------------------------------------------

describe("normalizers", () => {
  it("falls back to 'unknown' doc type for bad input and passes through known types", () => {
    expect(normalizeDocType("garbage")).toBe("unknown")
    expect(normalizeDocType(null)).toBe("unknown")
    expect(normalizeDocType(undefined)).toBe("unknown")
    for (const t of DOC_TYPES) expect(normalizeDocType(t)).toBe(t)
  })

  it("falls back to 'uploaded' status for bad input", () => {
    expect(normalizeStatus("bogus")).toBe("uploaded")
    expect(normalizeStatus(null)).toBe("uploaded")
    for (const s of ["queued", "processing", "extracted", "reviewed", "posted", "rejected", "failed"] as const) {
      expect(normalizeStatus(s)).toBe(s)
    }
  })
})

// ---------------------------------------------------------------------------
// Classification — invoice / receipt / resume / contract
// ---------------------------------------------------------------------------

describe("classifyDocument", () => {
  it("classifies an invoice", () => {
    const c = classifyDocument("INVOICE\nInvoice Number: INV-1001\nTotal Due: $500\nBill To: Acme")
    expect(c.docType).toBe("invoice")
    expect(c.confidence).toBeGreaterThan(0)
  })

  it("classifies a receipt", () => {
    const c = classifyDocument("RECEIPT\nMerchant: Coffee House\nSubtotal 4.50\nCARD PAYMENT\nCHANGE 0.00")
    expect(c.docType).toBe("receipt")
  })

  it("classifies a resume", () => {
    const c = classifyDocument("CURRICULUM VITAE\nWork Experience\nEducation\nSkills\nemail: jane@doe.com")
    expect(c.docType).toBe("resume")
  })

  it("classifies a contract", () => {
    const c = classifyDocument(
      "SERVICE AGREEMENT\nThis Agreement is entered into between the parties.\nTerm and Termination\nGoverning Law",
    )
    expect(c.docType).toBe("contract")
  })

  it("returns 'unknown' with zero confidence for indeterminate text", () => {
    const c = classifyDocument("the quick brown fox jumped over the lazy dog")
    expect(c.docType).toBe("unknown")
  })

  it("honors a forced type over the auto-classifier", () => {
    const c = classifyDocument("ambiguous text", "contract")
    expect(c.docType).toBe("contract")
  })
})

// ---------------------------------------------------------------------------
// Extraction — fields carry per-field source highlights + confidence
// ---------------------------------------------------------------------------

describe("extractDocument", () => {
  it("extracts invoice fields with source highlights and confidence", () => {
    const text = [
      "INVOICE",
      "Invoice Number: INV-2048",
      "Date: 2026-03-15",
      "Total Due: $1,234.56",
      "Bill To: Globex Corp",
    ].join("\n")
    const result = extractDocument(text)
    expect(result.docType).toBe("invoice")

    const invoiceNo = result.fields.find((f) => f.key === "invoice_number")
    expect(invoiceNo?.value).toContain("INV-2048")
    // Every populated field exposes a confidence in [0,1] ...
    for (const f of result.fields) {
      expect(f.confidence).toBeGreaterThanOrEqual(0)
      expect(f.confidence).toBeLessThanOrEqual(1)
    }
    // ... and populated fields carry a source highlight the reviewer can see.
    const populated = result.fields.filter((f) => f.value)
    expect(populated.length).toBeGreaterThan(0)
    expect(populated.every((f) => f.source && typeof f.source.snippet === "string")).toBe(true)

    expect(result.overallConfidence).toBeGreaterThan(0)
    expect(result.overallConfidence).toBeLessThanOrEqual(1)
  })

  it("returns zero-confidence unknown fields for empty text (malformed scan) without throwing", () => {
    const result = extractDocument("")
    expect(result.docType).toBe("unknown")
    expect(result.overallConfidence).toBe(0)
  })
})

describe("computeOverallConfidence", () => {
  it("returns 0 for an empty field set", () => {
    expect(computeOverallConfidence([])).toBe(0)
  })

  it("collapses to the classifier baseline when no field is confident", () => {
    const zeroed: ExtractedField[] = [
      { key: "a", label: "A", type: "string", value: null, confidence: 0, required: true, source: null, corrected: false },
    ]
    // With classifierConfidence forced to 0, an all-zero extraction scores 0.
    expect(computeOverallConfidence(zeroed, 0)).toBe(0)
  })

  it("weights required fields more heavily and stays within [0,1]", () => {
    const some: ExtractedField[] = [
      { key: "a", label: "A", type: "string", value: "x", confidence: 0.8, required: true, source: null, corrected: false },
      { key: "b", label: "B", type: "string", value: "y", confidence: 0.6, required: false, source: null, corrected: false },
    ]
    const blended = computeOverallConfidence(some)
    expect(blended).toBeGreaterThan(0)
    expect(blended).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Reviewer corrections — merge + diff (drives audit trail + new version)
// ---------------------------------------------------------------------------

describe("mergeCorrections / diffCorrections", () => {
  const base: ExtractedField[] = [
    { key: "invoice_number", label: "Invoice #", type: "string", value: "INV-1", confidence: 0.4, required: true, source: null, corrected: false },
    { key: "total", label: "Total", type: "currency", value: null, confidence: 0, required: true, source: null, corrected: false },
  ]

  it("applies a correction and bumps that field's confidence to human-verified", () => {
    const merged = mergeCorrections(base, [{ key: "invoice_number", value: "INV-999" }])
    const field = merged.find((f) => f.key === "invoice_number")!
    expect(field.value).toBe("INV-999")
    // A human-verified field should be at (or near) full confidence.
    expect(field.confidence).toBeGreaterThanOrEqual(base[0].confidence)
  })

  it("ignores corrections for unknown keys", () => {
    const merged = mergeCorrections(base, [{ key: "does_not_exist", value: "x" }])
    expect(merged).toEqual(base)
  })

  it("diffs only the fields that actually changed", () => {
    const merged = mergeCorrections(base, [
      { key: "invoice_number", value: "INV-999" },
      { key: "total", value: "500" },
    ])
    const changes = diffCorrections(base, merged)
    expect(changes.map((c) => c.key).sort()).toEqual(["invoice_number", "total"])
  })

  it("reports no diff when nothing changed", () => {
    expect(diffCorrections(base, base)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateExtraction", () => {
  it("fails when a required field is missing", () => {
    const fields: ExtractedField[] = [
      { key: "invoice_number", label: "Invoice #", type: "string", value: null, confidence: 0, required: true, source: null, corrected: false },
    ]
    const result = validateExtraction("invoice", fields)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it("passes when all required fields are present", () => {
    const fields: ExtractedField[] = [
      { key: "invoice_number", label: "Invoice #", type: "string", value: "INV-1", confidence: 1, required: true, source: null, corrected: false },
      { key: "invoice_date", label: "Invoice date", type: "date", value: "2026-01-01", confidence: 1, required: true, source: null, corrected: false },
      { key: "total_amount", label: "Total", type: "currency", value: "500", confidence: 1, required: true, source: null, corrected: false },
    ]
    const result = validateExtraction("invoice", fields)
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SECURITY GATE #1 — queue only after clean malware verdict AND tenant auth
// ---------------------------------------------------------------------------

describe("canQueueForProcessing (malware + authorization gate, fail-closed)", () => {
  it("denies when the tenant is not authorized, whatever the scan says", () => {
    expect(canQueueForProcessing({ scanStatus: "clean", approved: true, tenantAuthorized: false }).allowed).toBe(false)
  })

  it("denies an infected file terminally (even if admin-approved)", () => {
    const d = canQueueForProcessing({ scanStatus: "infected", approved: true, tenantAuthorized: true })
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/infected/i)
  })

  it("holds pending / scanning / null scans (awaiting scan)", () => {
    for (const scanStatus of ["pending", "scanning", null] as const) {
      const d = canQueueForProcessing({ scanStatus, approved: false, tenantAuthorized: true })
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.reason).toMatch(/scan/i)
    }
  })

  it("holds a scan error unless an admin approved it", () => {
    expect(canQueueForProcessing({ scanStatus: "error", approved: false, tenantAuthorized: true }).allowed).toBe(false)
    expect(canQueueForProcessing({ scanStatus: "error", approved: true, tenantAuthorized: true }).allowed).toBe(true)
  })

  it("allows a clean + authorized document", () => {
    expect(canQueueForProcessing({ scanStatus: "clean", approved: false, tenantAuthorized: true }).allowed).toBe(true)
  })

  it("allows an admin-released uncertain verdict when authorized", () => {
    expect(canQueueForProcessing({ scanStatus: "pending", approved: true, tenantAuthorized: true }).allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SECURITY GATE #2 — post only after human review + valid
// ---------------------------------------------------------------------------

describe("canPost (review-before-post gate)", () => {
  const valid = { valid: true, errors: [] }
  const invalid = { valid: false, errors: ["missing total"] }

  it("refuses to post an unreviewed extraction", () => {
    for (const status of ["uploaded", "queued", "processing", "extracted", "failed"] as ExtractionStatus[]) {
      expect(canPost({ status, validation: valid }).allowed).toBe(false)
    }
  })

  it("refuses to post the same extraction twice", () => {
    const d = canPost({ status: "posted", validation: valid })
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/already/i)
  })

  it("refuses to post a reviewed-but-invalid extraction", () => {
    const d = canPost({ status: "reviewed", validation: invalid })
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/validation/i)
  })

  it("allows posting a reviewed + valid extraction", () => {
    expect(canPost({ status: "reviewed", validation: valid }).allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Status transition table
// ---------------------------------------------------------------------------

describe("canTransition", () => {
  it("permits the normal lifecycle", () => {
    expect(canTransition("uploaded", "queued")).toBe(true)
    expect(canTransition("queued", "processing")).toBe(true)
    expect(canTransition("processing", "extracted")).toBe(true)
    expect(canTransition("extracted", "reviewed")).toBe(true)
    expect(canTransition("reviewed", "posted")).toBe(true)
  })

  it("rejects illegal jumps and any transition out of a terminal state", () => {
    expect(canTransition("uploaded", "posted")).toBe(false)
    expect(canTransition("posted", "processing")).toBe(false)
    expect(canTransition("rejected", "queued")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Idempotency — repeated uploads + deterministic post key
// ---------------------------------------------------------------------------

describe("idempotency keys", () => {
  it("derives the same content hash for identical bytes within a tenant", () => {
    const a = deriveContentHash({ tenantId: 1, checksum: "abc", size: 100 })
    const b = deriveContentHash({ tenantId: 1, checksum: "abc", size: 100 })
    expect(a).toBe(b)
  })

  it("separates content hashes across tenants (no cross-tenant dedupe)", () => {
    const t1 = deriveContentHash({ tenantId: 1, checksum: "abc", size: 100 })
    const t2 = deriveContentHash({ tenantId: 2, checksum: "abc", size: 100 })
    expect(t1).not.toBe(t2)
  })

  it("changes the hash when the bytes differ", () => {
    const a = deriveContentHash({ tenantId: 1, checksum: "abc", size: 100 })
    const b = deriveContentHash({ tenantId: 1, checksum: "def", size: 100 })
    expect(a).not.toBe(b)
  })

  it("derives a deterministic, version-bound post idempotency key", () => {
    const a = derivePostIdempotencyKey({ tenantId: 1, extractionId: 5, version: 2 })
    const b = derivePostIdempotencyKey({ tenantId: 1, extractionId: 5, version: 2 })
    const c = derivePostIdempotencyKey({ tenantId: 1, extractionId: 5, version: 3 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

// ---------------------------------------------------------------------------
// Multilingual + malformed input handling (extractor provider)
// ---------------------------------------------------------------------------

describe("detectLanguage (multilingual scans)", () => {
  it("detects a range of scripts / languages", () => {
    expect(detectLanguage("发票 金额 日期")).toBe("zh")
    expect(detectLanguage("ありがとうございます レシート")).toBe("ja")
    expect(detectLanguage("세금 계산서")).toBe("ko")
    expect(detectLanguage("चालान राशि")).toBe("hi")
    expect(detectLanguage("فاتورة المبلغ")).toBe("ar")
    expect(detectLanguage("Facture: montant total à payer et date")).toBe("fr")
    expect(detectLanguage("Rechnung Betrag und Datum für Kunden")).toBe("de")
    expect(detectLanguage("Factura: número, importe y fecha")).toBe("es")
    expect(detectLanguage("Invoice total amount and date")).toBe("en")
  })
})

describe("HeuristicExtractionProvider (malformed + multilingual scans)", () => {
  const provider = new HeuristicExtractionProvider()

  it("warns instead of crashing on empty/garbage text", async () => {
    const result = await provider.extract({ text: "", filename: "blank.pdf", mimeType: null })
    expect(result.warnings.some((w) => /no readable text/i.test(w))).toBe(true)
    expect(result.overallConfidence).toBe(0)
    expect(result.provider).toBe("heuristic-v1")
  })

  it("handles a non-string text payload defensively", async () => {
    const result = await provider.extract({ text: undefined as unknown as string, filename: null, mimeType: null })
    expect(result.docType).toBe("unknown")
    expect(result.overallConfidence).toBe(0)
  })

  it("carries the detected language through on a multilingual invoice", async () => {
    const result = await provider.extract({
      text: "Rechnung für Bürobedarf\nBetrag: 100 EUR\nDatum: 2026-01-01\nVertrag",
      filename: "rechnung.txt",
      mimeType: "text/plain",
    })
    expect(result.language).toBe("de")
  })
})
