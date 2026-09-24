import { describe, it, expect } from "vitest"
import {
  cleanRefValue,
  duplicateKey,
  defaultConfig,
  getDocumentDef,
  isDuplicatePolicy,
  isReferenceType,
  referenceTypeLabel,
  validateConfigInput,
  validateRefValue,
  DOCUMENT_TYPES,
  REFERENCE_TYPES,
} from "@/lib/references/model"

describe("SPEC 93 — reference type catalogue", () => {
  it("exposes the six spec reference types", () => {
    expect(REFERENCE_TYPES.map((r) => r.type)).toEqual([
      "internal",
      "external",
      "customer",
      "vendor",
      "po",
      "contract",
    ])
  })

  it("recognizes valid and rejects invalid reference types", () => {
    expect(isReferenceType("po")).toBe(true)
    expect(isReferenceType("nope")).toBe(false)
  })

  it("labels reference types", () => {
    expect(referenceTypeLabel("po")).toBe("PO reference")
    expect(referenceTypeLabel("mystery")).toBe("mystery")
  })
})

describe("SPEC 93 — value normalization (duplicate detection core)", () => {
  it("cleans a stored value without changing its casing", () => {
    expect(cleanRefValue("  PO   1234 ")).toBe("PO 1234")
    expect(cleanRefValue("Invoice-9")).toBe("Invoice-9")
  })

  it("collapses casing, spacing and punctuation for comparison", () => {
    expect(duplicateKey("PO-1234")).toBe("PO1234")
    expect(duplicateKey("po 1234")).toBe("PO1234")
    expect(duplicateKey("Po1234")).toBe("PO1234")
  })

  it("treats variants as the same reference but distinct values as different", () => {
    expect(duplicateKey("INV/2026/1")).toBe(duplicateKey("inv 2026 1"))
    expect(duplicateKey("INV-1")).not.toBe(duplicateKey("INV-2"))
  })

  it("returns an empty key for blank values (blanks never collide)", () => {
    expect(duplicateKey("")).toBe("")
    expect(duplicateKey("   ")).toBe("")
  })
})

describe("SPEC 93 — document catalogue defaults", () => {
  it("gives every document a complete config for all six reference types", () => {
    for (const doc of DOCUMENT_TYPES) {
      expect(doc.defaults.map((c) => c.refType).sort()).toEqual(
        REFERENCE_TYPES.map((r) => r.type).sort(),
      )
    }
  })

  it("blocks duplicate internal numbers on every document", () => {
    for (const doc of DOCUMENT_TYPES) {
      const internal = doc.defaults.find((c) => c.refType === "internal")!
      expect(internal.enabled).toBe(true)
      expect(internal.required).toBe(true)
      expect(internal.duplicate).toBe("block")
    }
  })

  it("resolves a catalogue default, falling back for unknown pairs", () => {
    const inv = defaultConfig("INV", "customer")
    expect(inv.enabled).toBe(true)
    expect(inv.duplicate).toBe("warn")

    const unknown = defaultConfig("NOPE", "vendor")
    expect(unknown).toEqual({ docType: "NOPE", refType: "vendor", enabled: false, required: false, duplicate: "off" })
  })

  it("looks up a known document definition", () => {
    expect(getDocumentDef("bill")?.label).toBe("Purchase bill")
    expect(getDocumentDef("unknown")).toBeUndefined()
  })
})

describe("SPEC 93 — config validation", () => {
  it("normalizes a valid config", () => {
    const res = validateConfigInput({ docType: "inv", refType: "po", enabled: true, duplicate: "warn" })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.config.docType).toBe("INV")
      expect(res.config.refType).toBe("po")
      expect(res.config.duplicate).toBe("warn")
    }
  })

  it("rejects an unknown reference type", () => {
    const res = validateConfigInput({ docType: "INV", refType: "bogus" })
    expect(res.ok).toBe(false)
  })

  it("rejects an unknown duplicate policy", () => {
    const res = validateConfigInput({ docType: "INV", refType: "po", duplicate: "sometimes" })
    expect(res.ok).toBe(false)
  })

  it("rejects a required-but-disabled reference", () => {
    const res = validateConfigInput({ docType: "INV", refType: "po", enabled: false, required: true })
    expect(res.ok).toBe(false)
  })

  it("recognizes duplicate policy values", () => {
    expect(isDuplicatePolicy("block")).toBe(true)
    expect(isDuplicatePolicy("maybe")).toBe(false)
  })
})

describe("SPEC 93 — value validation", () => {
  const enabled = { enabled: true, required: false }

  it("accepts and cleans a present value", () => {
    const res = validateRefValue(enabled, "  PO 42 ")
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value).toBe("PO 42")
      expect(res.key).toBe("PO42")
    }
  })

  it("rejects capturing a value for a disabled reference", () => {
    const res = validateRefValue({ enabled: false, required: false }, "X")
    expect(res.ok).toBe(false)
  })

  it("allows a blank value when optional but rejects when required", () => {
    expect(validateRefValue({ enabled: true, required: false }, "").ok).toBe(true)
    expect(validateRefValue({ enabled: true, required: true }, "  ").ok).toBe(false)
  })

  it("rejects an over-long value", () => {
    const res = validateRefValue(enabled, "x".repeat(121))
    expect(res.ok).toBe(false)
  })
})
