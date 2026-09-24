import { describe, it, expect } from "vitest"
import { validateModuleDefinition, type ModuleDefinition, type ModuleDefInput } from "@/lib/custom-modules/model"
import {
  MAX_MERGE_SECONDARIES,
  computeMerge,
  mergeAttachments,
  rewireReferences,
  validateMergeRequest,
  type MergeRecordInput,
} from "@/lib/custom-modules/merge"

/**
 * SPEC 104 — Phase 4. The record merge engine folds duplicate "secondary"
 * records into a surviving "primary" record. All of its correctness lives in
 * the pure model (no DB / server-only import): the operator's per-field value
 * choice, the union of attachments, the re-derivation of formula fields, and
 * the repointing of related references. These tests pin every rule the
 * transactional service and the rollback depend on.
 */

function buildModule(): ModuleDefinition {
  const input: ModuleDefInput = {
    name: "Contact",
    status: "published",
    fields: [
      { label: "Name", type: "text", showInList: true },
      { label: "Amount", type: "number", showInList: true },
      { label: "Linked", type: "entity", config: { targetEntity: "contact" } },
      { label: "Double", type: "formula", config: { formula: "amount * 2" } },
    ],
  }
  const parsed = validateModuleDefinition(input)
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join(", ")}`)
  return parsed.def
}

function record(id: number, values: Record<string, unknown>, attachments: MergeRecordInput["attachments"] = []): MergeRecordInput {
  return { id, state: null, values, attachments }
}

describe("validateMergeRequest", () => {
  it("requires at least one secondary", () => {
    const r = validateMergeRequest(1, [])
    expect(r.ok).toBe(false)
  })

  it("rejects the primary appearing among the secondaries", () => {
    const r = validateMergeRequest(1, [2, 1])
    expect(r.ok).toBe(false)
  })

  it("de-duplicates and drops invalid ids", () => {
    const r = validateMergeRequest(1, [2, 2, 3, 0, -5])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.secondaryIds).toEqual([2, 3])
  })

  it("caps the number of secondaries", () => {
    const many = Array.from({ length: MAX_MERGE_SECONDARIES + 1 }, (_, i) => i + 2)
    const r = validateMergeRequest(1, many)
    expect(r.ok).toBe(false)
  })
})

describe("computeMerge — field selection", () => {
  const def = buildModule()

  it("keeps the primary's values by default and re-derives the formula", () => {
    const primary = record(1, { name: "Ada", amount: 10 })
    const secondary = record(2, { name: "Ada Lovelace", amount: 99 })
    const merged = computeMerge(def, primary, [secondary], {})
    expect(merged.values.name).toBe("Ada")
    expect(merged.values.amount).toBe(10)
    // formula = amount * 2, derived from the RESOLVED (primary) operand
    expect(merged.values.double).toBe(20)
  })

  it("takes a secondary's value when that source is chosen", () => {
    const primary = record(1, { name: "Ada", amount: 10 })
    const secondary = record(2, { name: "Ada Lovelace", amount: 99 })
    const merged = computeMerge(def, primary, [secondary], { name: "2", amount: "2" })
    expect(merged.values.name).toBe("Ada Lovelace")
    expect(merged.values.amount).toBe(99)
    // formula re-derives from the chosen secondary operand
    expect(merged.values.double).toBe(198)
  })

  it("falls back to the primary when a chosen source is not a real secondary", () => {
    const primary = record(1, { name: "Ada", amount: 10 })
    const secondary = record(2, { name: "Ada Lovelace", amount: 99 })
    const merged = computeMerge(def, primary, [secondary], { name: "999" })
    expect(merged.values.name).toBe("Ada")
  })

  it("exposes each record's candidate value for the review UI", () => {
    const primary = record(1, { name: "Ada", amount: 10 })
    const secondary = record(2, { name: "Ada Lovelace", amount: 99 })
    const merged = computeMerge(def, primary, [secondary], {})
    const nameChoice = merged.fields.find((f) => f.key === "name")
    expect(nameChoice?.candidates).toEqual([
      { recordId: "primary", value: "Ada" },
      { recordId: 2, value: "Ada Lovelace" },
    ])
    const doubleChoice = merged.fields.find((f) => f.key === "double")
    expect(doubleChoice?.computed).toBe(true)
  })
})

describe("mergeAttachments", () => {
  const def = buildModule()

  it("unions distinct attachments across all records, deduped by url", () => {
    const primary = record(1, {}, [{ name: "a.pdf", url: "u/a", size: 1 }])
    const s1 = record(2, {}, [{ name: "a.pdf", url: "u/a", size: 1 }, { name: "b.pdf", url: "u/b", size: 2 }])
    const s2 = record(3, {}, [{ name: "c.pdf", url: "u/c", size: 3 }])
    const merged = computeMerge(def, primary, [s1, s2], {})
    expect(merged.attachments.map((a) => a.url)).toEqual(["u/a", "u/b", "u/c"])
  })

  it("caps the union at 50 attachments", () => {
    const big = record(1, {}, Array.from({ length: 60 }, (_, i) => ({ name: `f${i}`, url: `u/${i}`, size: null })))
    const out = mergeAttachments(big, [])
    expect(out.length).toBe(50)
  })
})

describe("rewireReferences — related records", () => {
  const def = buildModule()

  it("repoints an entity field that pointed at a retired secondary", () => {
    const values = { name: "Ref", linked: { entity: "contact", id: "2" } }
    const result = rewireReferences(def, values, new Set(["2", "3"]), "1")
    expect((result.values.linked as any).id).toBe("1")
    expect(result.changes).toEqual([{ key: "linked", from: "2", to: "1" }])
    // original object is not mutated
    expect((values.linked as any).id).toBe("2")
  })

  it("leaves references to untouched records alone", () => {
    const values = { linked: { entity: "contact", id: "9" } }
    const result = rewireReferences(def, values, new Set(["2", "3"]), "1")
    expect(result.changes).toEqual([])
    expect((result.values.linked as any).id).toBe("9")
  })
})
