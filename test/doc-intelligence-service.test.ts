import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * SPEC 19 (req #74) — Phase 4 verification for the AI Document Intelligence
 * SERVICE orchestration. Every external subsystem is mocked so the tests pin the
 * security-critical wiring without a database:
 *
 *   - intake is tenant-scoped: a wrong-tenant file id resolves to 404 (IDOR),
 *   - intake is idempotent on document content (repeated identical uploads),
 *   - processing is fail-closed on the malware verdict AND tenant authorization,
 *   - a processing failure is recorded as `failed`, never as a crash,
 *   - posting requires a prior human review and is idempotent (no double-create),
 *   - every step appends to the append-only audit trail.
 */

// --- Mocks for the subsystems the service composes (no DB, no network) ------

const storage = vi.hoisted(() => ({
  getFileById: vi.fn(),
  downloadFile: vi.fn(),
  getScanForFile: vi.fn(),
  registerModuleDocument: vi.fn(),
}))

vi.mock("@/lib/storage/file-metadata", () => ({ getFileById: storage.getFileById }))
vi.mock("@/lib/storage", () => ({ downloadFile: storage.downloadFile }))
vi.mock("@/lib/storage/file-scanning", () => ({ getScanForFile: storage.getScanForFile }))
vi.mock("@/lib/dms/integration", () => ({ registerModuleDocument: storage.registerModuleDocument }))
// safety-core is pure; keep the real redactString (it must not throw on our text).

// In-memory store standing in for the tenant-scoped MySQL persistence layer.
const db = vi.hoisted(() => {
  return {
    rows: new Map<number, any>(),
    audit: [] as any[],
    versions: [] as any[],
    seq: 0,
    reset() {
      this.rows.clear()
      this.audit.length = 0
      this.versions.length = 0
      this.seq = 0
    },
  }
})

vi.mock("@/lib/ai/document-intelligence/store", () => ({
  createExtraction: vi.fn(async (input: any) => {
    // Idempotent on content hash within the (single) tenant under test.
    for (const row of db.rows.values()) {
      if (row.contentHash === input.contentHash) return { extraction: { ...row }, deduped: true }
    }
    const id = ++db.seq
    const extraction = {
      id,
      tenantId: 7,
      fileId: input.fileId,
      fileRef: input.fileRef,
      dmsDocumentId: null,
      docType: input.docType,
      status: "uploaded",
      version: 0,
      provider: null,
      modelId: null,
      language: null,
      overallConfidence: 0,
      fields: [],
      highlights: [],
      warnings: [],
      contentHash: input.contentHash,
      postIdempotencyKey: null,
      postedEntityType: null,
      postedEntityId: null,
      reviewedBy: null,
      reviewedAt: null,
      postedBy: null,
      postedAt: null,
      error: null,
      createdBy: input.createdBy,
      createdAt: null,
      updatedAt: null,
    }
    db.rows.set(id, extraction)
    return { extraction: { ...extraction }, deduped: false }
  }),
  getExtraction: vi.fn(async (id: number) => {
    const row = db.rows.get(id)
    return row ? { ...row } : null
  }),
  updateExtraction: vi.fn(async (id: number, patch: any) => {
    const row = db.rows.get(id)
    if (!row) return 0
    Object.assign(row, patch)
    return 1
  }),
  snapshotVersion: vi.fn(async (input: any) => {
    db.versions.push(input)
  }),
  logExtractionAudit: vi.fn(async (input: any) => {
    db.audit.push(input)
  }),
  findByPostKey: vi.fn(async (key: string) => {
    for (const row of db.rows.values()) {
      if (row.postIdempotencyKey === key) return { ...row }
    }
    return null
  }),
}))

import {
  intakeExtraction,
  processExtraction,
  reviewExtraction,
  postExtraction,
  type Actor,
} from "@/lib/ai/document-intelligence/service"
import { setDocExtractionProvider, HeuristicExtractionProvider } from "@/lib/ai/document-intelligence/extractor"

const ADMIN: Actor = { userId: 1, role: "admin", isAdmin: true }
const TENANT = 7

function textFile(overrides: Record<string, any> = {}) {
  return {
    id: 100,
    tenantId: TENANT,
    fileRef: "FILE-100",
    filename: "invoice.txt",
    mimeType: "text/plain",
    objectKey: "tenant/7/invoice.txt",
    size: 512,
    checksum: "chk-100",
    ...overrides,
  }
}

const INVOICE_TEXT = [
  "INVOICE",
  "Invoice Number: INV-42",
  "Invoice Date: 2026-03-15",
  "Total: $100.00",
  "Bill To: Acme",
].join("\n")

function stubDownload(text: string) {
  storage.downloadFile.mockResolvedValue({ body: Buffer.from(text, "utf8") })
}

beforeEach(() => {
  db.reset()
  vi.clearAllMocks()
  setDocExtractionProvider(new HeuristicExtractionProvider())
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Intake — tenant scoping + content idempotency
// ---------------------------------------------------------------------------

describe("intakeExtraction — tenant scope + idempotency", () => {
  it("rejects a file that does not exist (404)", async () => {
    storage.getFileById.mockResolvedValue(null)
    const res = await intakeExtraction({ fileId: 999, tenantId: TENANT, createdBy: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })

  it("rejects a file owned by another tenant (cross-tenant IDOR → 404)", async () => {
    storage.getFileById.mockResolvedValue(textFile({ tenantId: 999 }))
    const res = await intakeExtraction({ fileId: 100, tenantId: TENANT, createdBy: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })

  it("creates an intake row and audits it", async () => {
    storage.getFileById.mockResolvedValue(textFile())
    const res = await intakeExtraction({ fileId: 100, tenantId: TENANT, createdBy: 1 })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.deduped).toBe(false)
      expect(res.extraction.status).toBe("uploaded")
    }
    expect(db.audit.some((a) => a.action === "intake")).toBe(true)
  })

  it("dedupes a repeated upload of identical bytes (no second row, no second audit)", async () => {
    storage.getFileById.mockResolvedValue(textFile())
    const first = await intakeExtraction({ fileId: 100, tenantId: TENANT, createdBy: 1 })
    const second = await intakeExtraction({ fileId: 100, tenantId: TENANT, createdBy: 1 })
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.deduped).toBe(true)
      expect(second.extraction.id).toBe(first.extraction.id)
    }
    expect(db.rows.size).toBe(1)
    expect(db.audit.filter((a) => a.action === "intake")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Processing gate — malware verdict + tenant authorization (fail-closed)
// ---------------------------------------------------------------------------

async function seedUploaded(): Promise<number> {
  storage.getFileById.mockResolvedValue(textFile())
  const res = await intakeExtraction({ fileId: 100, tenantId: TENANT, createdBy: 1 })
  if (!res.ok) throw new Error("seed failed")
  return res.extraction.id
}

describe("processExtraction — fail-closed malware + authorization gate", () => {
  it("denies processing when the tenant is not authorized", async () => {
    const id = await seedUploaded()
    storage.getScanForFile.mockResolvedValue({ scanStatus: "clean", approved: false })
    const res = await processExtraction({ extractionId: id, actor: ADMIN, tenantAuthorized: false })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(409)
    expect(db.audit.some((a) => a.action === "queue_denied")).toBe(true)
    expect(db.rows.get(id).status).toBe("uploaded") // untouched
  })

  it("holds processing while the malware scan is still pending", async () => {
    const id = await seedUploaded()
    storage.getScanForFile.mockResolvedValue({ scanStatus: "pending", approved: false })
    const res = await processExtraction({ extractionId: id, actor: ADMIN, tenantAuthorized: true })
    expect(res.ok).toBe(false)
    expect(db.rows.get(id).status).toBe("uploaded")
  })

  it("denies processing of an infected file terminally", async () => {
    const id = await seedUploaded()
    storage.getScanForFile.mockResolvedValue({ scanStatus: "infected", approved: true })
    const res = await processExtraction({ extractionId: id, actor: ADMIN, tenantAuthorized: true })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/infected/i)
  })

  it("extracts a clean + authorized document, snapshots a version, and audits it", async () => {
    const id = await seedUploaded()
    storage.getScanForFile.mockResolvedValue({ scanStatus: "clean", approved: false })
    stubDownload(INVOICE_TEXT)
    const res = await processExtraction({ extractionId: id, actor: ADMIN, tenantAuthorized: true })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.extraction.status).toBe("extracted")
      expect(res.extraction.docType).toBe("invoice")
      expect(res.extraction.version).toBe(1)
    }
    expect(db.versions).toHaveLength(1)
    expect(db.audit.some((a) => a.action === "extracted")).toBe(true)
  })

  it("records a provider failure as 'failed' rather than throwing", async () => {
    const id = await seedUploaded()
    storage.getScanForFile.mockResolvedValue({ scanStatus: "clean", approved: false })
    stubDownload(INVOICE_TEXT)
    setDocExtractionProvider({
      id: "boom",
      async extract() {
        throw new Error("model exploded")
      },
    })
    const res = await processExtraction({ extractionId: id, actor: ADMIN, tenantAuthorized: true })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(500)
    expect(db.rows.get(id).status).toBe("failed")
    expect(db.audit.some((a) => a.action === "failed")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Review + Post — review-before-post gate + posting idempotency
// ---------------------------------------------------------------------------

async function seedExtracted(): Promise<number> {
  const id = await seedUploaded()
  storage.getScanForFile.mockResolvedValue({ scanStatus: "clean", approved: false })
  stubDownload(INVOICE_TEXT)
  await processExtraction({ extractionId: id, actor: ADMIN, tenantAuthorized: true })
  return id
}

describe("postExtraction — review-before-post + idempotency", () => {
  it("refuses to post an extraction that has not been reviewed", async () => {
    const id = await seedExtracted()
    const res = await postExtraction({ extractionId: id, actor: ADMIN })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(409)
      expect(res.error).toMatch(/review/i)
    }
    expect(storage.registerModuleDocument).not.toHaveBeenCalled()
  })

  it("posts a reviewed + valid extraction into the DMS and audits it", async () => {
    const id = await seedExtracted()
    await reviewExtraction({
      extractionId: id,
      actor: ADMIN,
      corrections: [{ key: "invoice_number", value: "INV-42" }],
      decision: "approve",
    })
    storage.registerModuleDocument.mockResolvedValue({ id: 555 })
    const res = await postExtraction({ extractionId: id, actor: ADMIN })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.deduped).toBe(false)
      expect(res.extraction.status).toBe("posted")
      expect(res.extraction.dmsDocumentId).toBe(555)
    }
    expect(storage.registerModuleDocument).toHaveBeenCalledTimes(1)
    expect(db.audit.some((a) => a.action === "posted")).toBe(true)
  })

  it("is idempotent: re-posting returns the existing record without a second DMS document", async () => {
    const id = await seedExtracted()
    await reviewExtraction({ extractionId: id, actor: ADMIN, corrections: [], decision: "approve" })
    storage.registerModuleDocument.mockResolvedValue({ id: 777 })
    const first = await postExtraction({ extractionId: id, actor: ADMIN })
    const second = await postExtraction({ extractionId: id, actor: ADMIN })
    expect(first.ok && second.ok).toBe(true)
    if (second.ok) expect(second.deduped).toBe(true)
    // The DMS document was created exactly once across both posts.
    expect(storage.registerModuleDocument).toHaveBeenCalledTimes(1)
  })

  it("a rejected extraction cannot be posted", async () => {
    const id = await seedExtracted()
    await reviewExtraction({ extractionId: id, actor: ADMIN, corrections: [], decision: "reject" })
    const res = await postExtraction({ extractionId: id, actor: ADMIN })
    expect(res.ok).toBe(false)
    expect(storage.registerModuleDocument).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Review — correction audit + versioning
// ---------------------------------------------------------------------------

describe("reviewExtraction — corrections produce a new version + audit", () => {
  it("records a corrected field as a new version in the audit trail", async () => {
    const id = await seedExtracted()
    const before = db.rows.get(id).version
    const res = await reviewExtraction({
      extractionId: id,
      actor: ADMIN,
      corrections: [{ key: "invoice_number", value: "CORRECTED-1" }],
      decision: "approve",
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.extraction.status).toBe("reviewed")
      expect(res.extraction.version).toBe(before + 1)
      expect(res.extraction.reviewedBy).toBe(ADMIN.userId)
    }
    expect(db.audit.some((a) => a.action === "reviewed")).toBe(true)
  })

  it("approving without changes does not bump the version", async () => {
    const id = await seedExtracted()
    const before = db.rows.get(id).version
    const res = await reviewExtraction({ extractionId: id, actor: ADMIN, corrections: [], decision: "approve" })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.extraction.version).toBe(before)
  })
})
