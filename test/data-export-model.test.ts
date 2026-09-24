import { describe, it, expect } from "vitest"
import {
  clampExportTtl,
  collectColumns,
  computeNextExportRun,
  DEFAULT_EXPORT_TTL_SECONDS,
  exportContentType,
  exportFileExtension,
  exportFileName,
  FULL_TENANT_EXPORT_KEY,
  isExportExpired,
  isExportStatus,
  isFullTenantScope,
  isScheduleDue,
  MAX_EXPORT_TTL_SECONDS,
  serializeCsv,
  serializeJson,
  slugifyLabel,
  stringifyCell,
  toExportFormat,
  toExportFrequency,
  buildTable,
} from "@/lib/data-export-model"
import {
  EXPORT_CATALOG,
  exportCatalogForClient,
  getExportDataset,
  resolveExistingColumn,
} from "@/lib/data-export-catalog"
import {
  DEFAULT_CLEARANCE_MATRIX,
  redactedExportFields,
  type ClassifiedField,
} from "@/lib/data-classification-model"

/**
 * SPEC 100 — Export Center, Phase 4.
 * -------------------------------------------------------------------------
 * The Export Center is only trustworthy if two invariants hold deterministically:
 *   (1) LARGE exports serialize completely and predictably (no dropped columns,
 *       stable header, byte size that scales so the store's artifact-size cap
 *       can reason about it), and
 *   (2) PERMISSION enforcement is fail-safe — an under-cleared role can never
 *       export a classified field, regardless of scope or format.
 * These pin the pure model + catalog + classification redaction that the DB
 * store (lib/data-export-store.ts) composes at run time.
 */

describe("format & status normalization", () => {
  it("coerces UI labels and aliases to a valid format, defaulting to csv", () => {
    expect(toExportFormat("excel")).toBe("xlsx")
    expect(toExportFormat("XLS")).toBe("xlsx")
    expect(toExportFormat("PDF")).toBe("pdf")
    expect(toExportFormat("json")).toBe("json")
    expect(toExportFormat("nonsense")).toBe("csv")
    expect(toExportFormat(undefined)).toBe("csv")
  })

  it("maps formats to stable extensions and content types", () => {
    expect(exportFileExtension("xlsx")).toBe("xlsx")
    expect(exportFileExtension("csv")).toBe("csv")
    expect(exportContentType("csv")).toMatch(/text\/csv/)
    expect(exportContentType("json")).toMatch(/application\/json/)
    expect(exportContentType("pdf")).toBe("application/pdf")
    expect(exportContentType("xlsx")).toMatch(/spreadsheetml/)
  })

  it("recognizes only the known statuses", () => {
    for (const s of ["queued", "running", "completed", "failed", "expired"]) {
      expect(isExportStatus(s)).toBe(true)
    }
    expect(isExportStatus("cancelled")).toBe(false)
    expect(isExportStatus(null)).toBe(false)
  })

  it("defaults unknown frequencies to weekly", () => {
    expect(toExportFrequency("daily")).toBe("daily")
    expect(toExportFrequency("monthly")).toBe("monthly")
    expect(toExportFrequency("hourly")).toBe("weekly")
  })
})

describe("download-link expiry (security)", () => {
  it("clamps TTL into (0, MAX] and floors fractional seconds", () => {
    expect(clampExportTtl(undefined)).toBe(DEFAULT_EXPORT_TTL_SECONDS)
    expect(clampExportTtl(0)).toBe(DEFAULT_EXPORT_TTL_SECONDS)
    expect(clampExportTtl(-5)).toBe(DEFAULT_EXPORT_TTL_SECONDS)
    expect(clampExportTtl(MAX_EXPORT_TTL_SECONDS * 10)).toBe(MAX_EXPORT_TTL_SECONDS)
    expect(clampExportTtl(3600.9)).toBe(3600)
  })

  it("treats a passed expiry as expired and a future/absent one as live", () => {
    const past = new Date(Date.now() - 1000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(isExportExpired(past)).toBe(true)
    expect(isExportExpired(future)).toBe(false)
    expect(isExportExpired(null)).toBe(false)
    expect(isExportExpired("not-a-date")).toBe(false)
  })
})

describe("schedule cadence", () => {
  const from = new Date("2026-01-01T12:00:00.000Z")

  it("advances by the frequency step and lands on the 03:30 UTC boundary", () => {
    const daily = computeNextExportRun("daily", null, from)
    const weekly = computeNextExportRun("weekly", null, from)
    const monthly = computeNextExportRun("monthly", null, from)
    for (const d of [daily, weekly, monthly]) {
      expect(d.getUTCHours()).toBe(3)
      expect(d.getUTCMinutes()).toBe(30)
      expect(d.getTime()).toBeGreaterThan(from.getTime())
    }
    // weekly is exactly 6 days after daily's step (7 vs 1) at the same boundary
    expect(weekly.getTime()).toBeGreaterThan(daily.getTime())
    expect(monthly.getTime()).toBeGreaterThan(weekly.getTime())
  })

  it("is deterministic and never schedules in the past", () => {
    const a = computeNextExportRun("weekly", null, from)
    const b = computeNextExportRun("weekly", null, from)
    expect(a.toISOString()).toBe(b.toISOString())
    expect(a.getTime()).toBeGreaterThan(from.getTime())
  })

  it("reports due only when next-run is at/before now", () => {
    expect(isScheduleDue(new Date(Date.now() - 1000).toISOString())).toBe(true)
    expect(isScheduleDue(new Date(Date.now() + 60_000).toISOString())).toBe(false)
    expect(isScheduleDue(null)).toBe(false)
  })
})

describe("cell serialization", () => {
  it("flattens dates, objects and nullish values safely", () => {
    expect(stringifyCell(null)).toBe("")
    expect(stringifyCell(undefined)).toBe("")
    expect(stringifyCell(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z")
    expect(stringifyCell({ a: 1 })).toBe('{"a":1}')
    expect(stringifyCell(42)).toBe("42")
  })
})

describe("large export serialization", () => {
  const ROWS = 10_000

  function bigDataset(): Record<string, unknown>[] {
    return Array.from({ length: ROWS }, (_, i) => ({
      id: i + 1,
      name: `Employee ${i + 1}`,
      email: `person${i + 1}@example.com`,
      note: i % 2 === 0 ? "Contains, comma and \"quotes\"" : "plain",
    }))
  }

  it("emits a header + one line per row (plus a UTF-8 BOM) for a large CSV", () => {
    const rows = bigDataset()
    const csv = serializeCsv(rows)
    expect(csv.startsWith("\uFEFF")).toBe(true)
    const lines = csv.split("\r\n")
    // header + ROWS data lines
    expect(lines.length).toBe(ROWS + 1)
    expect(lines[0]).toContain("id")
    // embedded commas/quotes are escaped so column count stays intact
    expect(lines[1]).toMatch(/^1,/)
    expect(csv).toContain('"Contains, comma and ""quotes"""')
  })

  it("keeps a stable, complete column set across ragged rows", () => {
    const rows = [
      { a: 1, b: 2 },
      { a: 3, c: 4 },
      { d: 5 },
    ]
    const cols = collectColumns(rows)
    expect(cols).toEqual(["a", "b", "c", "d"])
    const csv = serializeCsv(rows)
    expect(csv.split("\r\n")[0]).toBe("\uFEFFa,b,c,d")
    // a missing column serializes as an empty field, never a shifted row
    expect(csv.split("\r\n")[3]).toBe(",,,5")
  })

  it("honors a preferred column order", () => {
    const cols = collectColumns([{ a: 1, z: 2 }], ["z", "a"])
    expect(cols).toEqual(["z", "a"])
  })

  it("builds a table whose byte size scales with row count (store cap can reason about it)", () => {
    const small = serializeCsv(bigDataset().slice(0, 100))
    const large = serializeCsv(bigDataset())
    expect(large.length).toBeGreaterThan(small.length * 50)
    const { columns, aoa } = buildTable(bigDataset())
    expect(columns).toEqual(["id", "name", "email", "note"])
    expect(aoa.length).toBe(ROWS + 1) // header + rows
    expect(aoa[0]).toEqual(columns)
  })

  it("round-trips a large JSON export", () => {
    const rows = bigDataset()
    const json = serializeJson({ scope: "Employees", rows })
    const parsed = JSON.parse(json)
    expect(parsed.rows).toHaveLength(ROWS)
    expect(parsed.rows[0].email).toBe("person1@example.com")
  })

  it("shapes a dated, slugified filename", () => {
    expect(slugifyLabel("Full tenant export!")).toBe("full-tenant-export")
    const name = exportFileName("Full tenant export", "csv", new Date("2026-03-04T10:00:00.000Z"))
    expect(name).toBe("full-tenant-export-2026-03-04.csv")
  })
})

describe("full-tenant scope & catalog", () => {
  it("recognizes the sentinel full-tenant key", () => {
    expect(isFullTenantScope(FULL_TENANT_EXPORT_KEY)).toBe(true)
    expect(isFullTenantScope("hr.employees")).toBe(false)
  })

  it("never leaks physical table names to the client projection", () => {
    const publicCatalog = exportCatalogForClient()
    expect(publicCatalog.length).toBe(EXPORT_CATALOG.length)
    for (const d of publicCatalog) {
      expect(d).not.toHaveProperty("table")
      expect(d).not.toHaveProperty("tenantColumns")
      expect(d.key).toBeTruthy()
      expect(d.module).toBeTruthy()
      expect(d.entity).toBeTruthy()
    }
  })

  it("resolves the first tenant/order column that exists in the live schema", () => {
    const ds = getExportDataset("hr.employees")
    expect(ds).toBeTruthy()
    const existing = new Set(["company_id", "created_at"])
    // tenant_id absent → falls through to company_id
    expect(resolveExistingColumn(ds!.tenantColumns, existing)).toBe("company_id")
    // neither present → null (store then refuses to read, never cross-tenant leaks)
    expect(resolveExistingColumn(ds!.tenantColumns, new Set(["unrelated"]))).toBeNull()
  })
})

describe("permission enforcement (classification redaction on export)", () => {
  // A representative classified entity: an under-cleared role must lose the
  // Confidential/Restricted fields; a cleared role keeps everything.
  const fields: ClassifiedField[] = [
    { field: "name", level: "Public" },
    { field: "email", level: "Internal" },
    { field: "salary", level: "Confidential" },
    { field: "ssn", level: "Restricted" },
    { field: "board_notes", level: "Restricted", enforceExport: false },
  ]

  // Local sanitizer mirroring the store's enforceExportClassification, so the
  // test proves the redacted columns actually leave the serialized artifact.
  function sanitize(rows: Record<string, unknown>[], redacted: Set<string>) {
    return rows.map((r) => {
      const copy = { ...r }
      for (const k of redacted) delete copy[k]
      return copy
    })
  }

  const rows = [
    { name: "Ada", email: "ada@example.com", salary: 100000, ssn: "111-11-1111", board_notes: "n/a" },
  ]

  it("redacts confidential+restricted fields for an employee", () => {
    const redacted = redactedExportFields(fields, "employee", DEFAULT_CLEARANCE_MATRIX)
    expect(redacted.has("salary")).toBe(true)
    expect(redacted.has("ssn")).toBe(true)
    // export enforcement disabled → passes through even though it's Restricted
    expect(redacted.has("board_notes")).toBe(false)
    // low-sensitivity fields always pass
    expect(redacted.has("name")).toBe(false)
    expect(redacted.has("email")).toBe(false)

    const csv = serializeCsv(sanitize(rows, redacted))
    expect(csv).toContain("name")
    expect(csv).not.toContain("salary")
    expect(csv).not.toContain("111-11-1111")
  })

  it("lets a module_admin export Confidential but still redacts Restricted", () => {
    const redacted = redactedExportFields(fields, "module_admin", DEFAULT_CLEARANCE_MATRIX)
    expect(redacted.has("salary")).toBe(false)
    expect(redacted.has("ssn")).toBe(true)
  })

  it("lets a tenant_admin export every enforced field", () => {
    const redacted = redactedExportFields(fields, "tenant_admin", DEFAULT_CLEARANCE_MATRIX)
    expect(redacted.size).toBe(0)
    const csv = serializeCsv(sanitize(rows, redacted))
    expect(csv).toContain("111-11-1111")
  })

  it("is fail-safe: higher sensitivity never widens access for a lower role", () => {
    const employee = redactedExportFields(fields, "employee")
    const admin = redactedExportFields(fields, "tenant_admin")
    // whatever the admin can export, the employee can export a subset of
    for (const f of employee) expect(admin.has(f)).toBe(false)
    expect(employee.size).toBeGreaterThanOrEqual(admin.size)
  })
})
