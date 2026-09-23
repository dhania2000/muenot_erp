import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ query: vi.fn(), connQuery: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }))
const audit = vi.hoisted(() => vi.fn())
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: db.query, pool: { getConnection: async () => ({ query: db.connQuery, beginTransaction: db.begin, commit: db.commit, rollback: db.rollback, release: db.release }) } }))
vi.mock("@/lib/platform-roles", () => ({ recordPlatformAudit: audit }))

import { createRelease, editDraft, latestPublicRelease, setReleasePublished } from "@/lib/mobile-app-releases"

const base = { application: "muenot-shopkeeper", platform: "android", version_name: "1.0.1", version_code: 2, minimum_supported_version_code: 1, apk_url: "https://downloads.example/app-2.apk", apk_size: 1234, apk_sha256: "a".repeat(64), release_notes: '["Fix"]', force_update: 0, status: "draft" as "draft" | "published", published_at: null as string | null, created_by: 12, updated_by: 12, created_at: "2026-09-23", updated_at: "2026-09-23" }
const actor = { userId: 12, email: "admin@example.test" }

beforeEach(() => {
  vi.clearAllMocks()
  db.query.mockResolvedValue([])
  db.connQuery.mockResolvedValue([{ affectedRows: 1 }])
  db.rollback.mockResolvedValue(undefined)
})

describe("release persistence", () => {
  it("maps duplicate versionCode to a conflict", async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("INSERT")) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" })
      return []
    })
    await expect(createRelease({ application: "muenot-shopkeeper", platform: "android", versionName: "1.0.1", versionCode: 2, minimumVersionCode: 1, apkUrl: "", apkSize: null, apkSha256: "", releaseNotes: [], forceUpdate: false }, actor)).rejects.toMatchObject({ status: 409 })
    expect(audit).not.toHaveBeenCalled()
  })
  it("requires complete metadata before publishing and locks the row", async () => {
    db.connQuery.mockImplementation(async (sql: string) => sql.includes("FOR UPDATE") ? [[{ ...base, id: 7, apk_url: null, apk_size: null, apk_sha256: null }]] : [{ affectedRows: 1 }])
    await expect(setReleasePublished(7, true, actor)).rejects.toThrow(/required/)
    expect(db.connQuery.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(true)
    expect(db.commit).not.toHaveBeenCalled()
    expect(db.rollback).toHaveBeenCalledOnce()
  })
  it("cannot edit a once-published release after it is unpublished", async () => {
    db.connQuery.mockImplementation(async (sql: string) => sql.includes("FOR UPDATE") ? [[{ ...base, id: 7, published_at: "2026-09-22" }]] : [{ affectedRows: 1 }])
    await expect(editDraft(7, { application: "muenot-shopkeeper", platform: "android", versionName: "1.0.1", versionCode: 2, minimumVersionCode: 1, apkUrl: base.apk_url, apkSize: 1234, apkSha256: "a".repeat(64), releaseNotes: ["Fix"], forceUpdate: false }, actor)).rejects.toMatchObject({ status: 409 })
    expect(db.connQuery.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE"))).toHaveLength(0)
  })
  it("makes a repeated publish idempotent", async () => {
    let row = { ...base, id: 7 }
    db.connQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) return [[row]]
      if (sql.startsWith("UPDATE")) { row = { ...row, status: "published", published_at: "2026-09-23" }; return [{ affectedRows: 1 }] }
      return [{ affectedRows: 1 }]
    })
    db.query.mockImplementation(async (sql: string) => sql.startsWith("SELECT r.*") ? [row] : [])
    await setReleasePublished(7, true, actor)
    await setReleasePublished(7, true, actor)
    expect(db.connQuery.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE"))).toHaveLength(1)
    expect(audit).toHaveBeenCalledTimes(1)
  })
  it("returns only the highest valid published row, then the next after unpublish", async () => {
    const high = { ...base, id: 8, version_name: "1.1.0", version_code: 3, minimum_supported_version_code: 2, force_update: 1, status: "published", published_at: "2026-09-23 10:00:00" }
    const low = { ...base, id: 7, status: "published", published_at: "2026-09-22 10:00:00" }
    db.query.mockResolvedValueOnce([high, low]).mockResolvedValueOnce([low])
    expect(await latestPublicRelease()).toMatchObject({ latestVersionCode: 3, minimumVersionCode: 2, forceUpdate: true })
    expect(await latestPublicRelease()).toMatchObject({ latestVersionCode: 2, minimumVersionCode: 1, forceUpdate: false })
    const statement = db.query.mock.calls[0][0] as string
    expect(statement).toContain("status='published'")
    expect(statement).toContain("ORDER BY version_code DESC")
  })
  it("skips malformed published rows and never exposes private fields", async () => {
    db.query.mockResolvedValue([{ ...base, id: 8, status: "published", published_at: "2026-09-23 10:00:00", apk_sha256: "bad" }, { ...base, id: 7, status: "published", published_at: "2026-09-22 10:00:00" }])
    const result = await latestPublicRelease()
    expect(result?.latestVersionCode).toBe(2)
    expect(result).not.toHaveProperty("createdBy")
    expect(result).not.toHaveProperty("status")
  })
})
