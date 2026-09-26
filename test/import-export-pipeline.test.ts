import { describe, expect, it } from "vitest"
import { IMPORT_ADAPTERS, applyAdapter, getImportAdapter } from "@/lib/import-adapters"
import { getImportDataset } from "@/lib/data-import-catalog"
import {
  ImportValidationError,
  MAX_IMPORT_COLUMNS,
  batchCommitKey,
  batchRowRange,
  buildBatchErrorCsv,
  canResume,
  canRollback,
  isValidBatchIdempotencyKey,
  looksLikeFormula,
  mergeOutcome,
  emptyOutcome,
  nextBatchIndex,
  planBatchCount,
  validateHeaders,
  validateStagedChunk,
} from "@/lib/data-import-batches-model"
import {
  FULL_TENANT_EXPORT_KEY,
  assertFormatScope,
  buildTable,
  isAcceptedExportFormatInput,
  serializeCsv,
  serializeJson,
  toExportFormat,
} from "@/lib/data-export-model"

describe("reviewed adapter catalog (Tally / HRMS / CRM)", () => {
  it("covers all three sources", () => {
    const sources = new Set(IMPORT_ADAPTERS.map((a) => a.source))
    expect([...sources].sort()).toEqual(["crm", "hrms", "tally"])
  })

  it.each(IMPORT_ADAPTERS.map((a) => [a.key, a] as const))("%s maps only onto real target columns", (_k, adapter) => {
    const config = getImportDataset(adapter.datasetKey)
    expect(config, `dataset ${adapter.datasetKey}`).toBeDefined()
    const columns = new Set(config!.columns.map((c: { key: string }) => c.key))
    for (const target of [...Object.values(adapter.fieldMap), ...Object.keys(adapter.derive ?? {})]) {
      expect(columns.has(target), `${adapter.key} → ${target}`).toBe(true)
    }
  })

  it("has unique adapter keys", () => {
    const keys = IMPORT_ADAPTERS.map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("does not map a GSTIN onto an e-invoice IRN field", () => {
    for (const a of IMPORT_ADAPTERS) {
      for (const [src, target] of Object.entries(a.fieldMap)) {
        if (/gstin/i.test(src)) expect(target).not.toMatch(/irn/i)
      }
    }
  })

  it("matches vendor headers loosely and neutralizes formula payloads", () => {
    const adapter = IMPORT_ADAPTERS[0]
    const [vendorHeader, target] = Object.entries(adapter.fieldMap)[0]
    const res = applyAdapter(adapter, [{ [`  ${vendorHeader.toUpperCase()} `]: '=HYPERLINK("http://x","y")', Junk: "z" }])
    expect(res.rows[0][target].startsWith("'=")).toBe(true)
    expect(res.unmappedSourceHeaders).toContain("Junk")
    expect(getImportAdapter("does-not-exist")).toBeUndefined()
  })
})

describe("malformed staged files", () => {
  it("rejects non-array and non-object rows", () => {
    expect(() => validateStagedChunk("nope")).toThrow(ImportValidationError)
    expect(() => validateStagedChunk([1, 2])).toThrow(ImportValidationError)
  })

  it("rejects too many columns and bad headers", () => {
    const wide = Object.fromEntries(Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, i) => [`c${i}`, "x"]))
    expect(() => validateStagedChunk([wide])).toThrow(ImportValidationError)
    expect(() => validateHeaders("x")).toThrow(ImportValidationError)
    expect(() => validateHeaders([])).toThrow(ImportValidationError)
    expect(() => validateHeaders(["id", "id"])).toThrow(/Duplicate column header/)
    expect(() => validateHeaders([{}])).toThrow(ImportValidationError)
  })
})

describe("formula injection", () => {
  it.each(["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\t=x", "\r=x"])("flags %j", (v) => {
    expect(looksLikeFormula(v)).toBe(true)
  })

  it("leaves plain negative numbers and text alone", () => {
    expect(looksLikeFormula("-42.5")).toBe(false)
    expect(looksLikeFormula("Acme")).toBe(false)
  })

  it("neutralizes CSV header cells, body cells and the error report", () => {
    const csv = serializeCsv([{ "=evil": "=HYPERLINK(1)", ok: "fine" }])
    const [header, body] = csv.replace(/^\uFEFF/, "").split("\r\n")
    expect(header.startsWith("'=evil")).toBe(true)
    expect(body.startsWith("'=HYPERLINK")).toBe(true)
    const report = buildBatchErrorCsv([{ row: 2, type: "duplicate", messages: ["=bad", "dup id"] }])
    expect(report).not.toMatch(/(^|,)=bad/m)
    expect(report).toContain("duplicate")
  })

  it("keeps JSON faithful (not a spreadsheet surface)", () => {
    expect(JSON.parse(serializeJson({ a: "=1" })).a).toBe("=1")
    expect(buildTable([{ a: "=1" }]).aoa[1][0]).toBe("'=1")
  })
})

describe("resumable batches for 100k+ rows", () => {
  it("plans and ranges 120k rows at 5k/batch", () => {
    expect(planBatchCount(120_000, 5_000)).toBe(24)
    expect(batchRowRange(23, 5_000, 120_000)).toEqual({ start: 115_000, end: 120_000 })
    expect(nextBatchIndex(24, 24)).toBeNull()
    expect(nextBatchIndex(10, 24)).toBe(10)
  })

  it("derives a stable per-batch commit key so a resumed batch never double-inserts", () => {
    expect(batchCommitKey(9, 3)).toBe(batchCommitKey("9", 3))
    expect(batchCommitKey(9, 3)).not.toBe(batchCommitKey(9, 4))
  })

  it("caps accumulated issues", () => {
    const issue = { row: 1, field: "x", message: "m" }
    const big = { ...emptyOutcome(), failed: 5, issues: Array(5).fill(issue) }
    expect(mergeOutcome(emptyOutcome(), big, 3).issues).toHaveLength(3)
  })

  it("only allows resume/rollback from safe states", () => {
    expect(canResume("interrupted")).toBe(true)
    expect(canResume("rolled_back" as never)).toBe(false)
    expect(canRollback("running" as never, 10)).toBe(false)
    expect(canRollback("completed" as never, 0)).toBe(false)
  })

  it("validates idempotency keys", () => {
    expect(isValidBatchIdempotencyKey("abc")).toBe(false)
    expect(isValidBatchIdempotencyKey("2f1c8a8e-0c9b-4c3a-9f6a-1e2d3c4b5a69")).toBe(true)
    expect(isValidBatchIdempotencyKey("bad key with spaces!!")).toBe(false)
  })
})

describe("export formats", () => {
  it("accepts csv/xlsx/json/backup and rejects others", () => {
    for (const f of ["csv", "xlsx", "json", "backup"]) expect(toExportFormat(f)).toBe(f)
    expect(isAcceptedExportFormatInput("exe")).toBe(false)
    expect(isAcceptedExportFormatInput(undefined)).toBe(true)
    expect(isAcceptedExportFormatInput("XLSX")).toBe(true)
  })

  it("restricts backup packages to the full-tenant scope", () => {
    expect(() => assertFormatScope("backup", "crm-leads")).toThrow()
    expect(() => assertFormatScope("backup", FULL_TENANT_EXPORT_KEY)).not.toThrow()
  })
})
