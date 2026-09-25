import { describe, expect, it } from "vitest"
import {
  clampDownloadTtl,
  clampUploadTtl,
  decideIntentCompletion,
  decideIntentReplay,
  decideMultipartCompletion,
  DEFAULT_UPLOAD_URL_TTL_SECONDS,
  isSafeTenantKey,
  isValidIdempotencyKey,
  MAX_DOWNLOAD_URL_TTL_SECONDS,
  MAX_UPLOAD_URL_TTL_SECONDS,
  uploadRequestFingerprint,
} from "@/lib/storage/presign-policy"

/**
 * Spec7 — presign authorization policy (pure decisions).
 *
 * Covers cross-tenant key guessing, TTL clamping (short-lived URLs),
 * idempotency/replay of presigned uploads, direct-upload completion (server
 * verifies the object instead of trusting the client) and multipart completion
 * including revoked connections and missing chunks.
 */

describe("isSafeTenantKey (cross-tenant guessing)", () => {
  it("accepts a key inside the caller's own namespace", () => {
    expect(isSafeTenantKey("t/42/erp/report.pdf", 42)).toBe(true)
  })

  it("rejects another tenant's key even if guessed correctly", () => {
    expect(isSafeTenantKey("t/43/erp/report.pdf", 42)).toBe(false)
  })

  it("rejects traversal, absolute and malformed keys", () => {
    expect(isSafeTenantKey("t/42/../43/x", 42)).toBe(false)
    expect(isSafeTenantKey("/t/42/x", 42)).toBe(false)
    expect(isSafeTenantKey("erp/report.pdf", 42)).toBe(false)
    expect(isSafeTenantKey("", 42)).toBe(false)
  })
})

describe("isValidIdempotencyKey", () => {
  it("accepts reasonable opaque keys and rejects junk", () => {
    expect(isValidIdempotencyKey("018f0b3e-1d2c-7a3b-9f00-abc123")).toBe(true)
    expect(isValidIdempotencyKey("")).toBe(false)
    expect(isValidIdempotencyKey(null)).toBe(false)
    expect(isValidIdempotencyKey("x".repeat(200))).toBe(false)
    expect(isValidIdempotencyKey("has space")).toBe(false)
  })
})

describe("TTL clamps (short-lived URLs)", () => {
  it("clamps upload TTL into range with a sane default", () => {
    expect(clampUploadTtl(60)).toBe(60)
    expect(clampUploadTtl(99999)).toBe(MAX_UPLOAD_URL_TTL_SECONDS)
    expect(clampUploadTtl(0)).toBe(DEFAULT_UPLOAD_URL_TTL_SECONDS)
    expect(clampUploadTtl("nonsense")).toBe(DEFAULT_UPLOAD_URL_TTL_SECONDS)
    expect(clampUploadTtl(-5)).toBe(DEFAULT_UPLOAD_URL_TTL_SECONDS)
  })

  it("clamps download TTL to its own ceiling", () => {
    expect(clampDownloadTtl(99999)).toBe(MAX_DOWNLOAD_URL_TTL_SECONDS)
  })
})

describe("decideIntentReplay (idempotency)", () => {
  const fp = uploadRequestFingerprint({ path: "erp", filename: "a.pdf", size: 10, contentType: "application/pdf" })

  it("creates when nothing exists", () => {
    expect(decideIntentReplay(null, fp, 1)).toEqual({ action: "create" })
  })

  it("reissues a fresh URL for the same body on the same connection", () => {
    expect(
      decideIntentReplay({ status: "pending", requestFingerprint: fp, expiresAt: new Date(), connectionId: 1 }, fp, 1),
    ).toEqual({ action: "reissue" })
  })

  it("replays a completed intent (no new URL)", () => {
    expect(
      decideIntentReplay({ status: "completed", requestFingerprint: fp, expiresAt: new Date(), connectionId: 1 }, fp, 1),
    ).toEqual({ action: "replay_completed" })
  })

  it("conflicts when the same key is reused for a different body", () => {
    const r = decideIntentReplay(
      { status: "pending", requestFingerprint: "other", expiresAt: new Date(), connectionId: 1 },
      fp,
      1,
    )
    expect(r.action).toBe("conflict")
  })

  it("conflicts when the active connection changed", () => {
    const r = decideIntentReplay(
      { status: "pending", requestFingerprint: fp, expiresAt: new Date(), connectionId: 1 },
      fp,
      2,
    )
    expect(r.action).toBe("conflict")
  })
})

describe("decideIntentCompletion (server verifies the object)", () => {
  const future = new Date(Date.now() + 60_000)
  const past = new Date(Date.now() - 60_000)

  it("completes when the uploaded object matches the authorized size", () => {
    expect(
      decideIntentCompletion({ status: "pending", declaredSize: 10, expiresAt: future }, { size: 10, contentType: "application/pdf" }),
    ).toEqual({ action: "complete" })
  })

  it("replays a completed intent", () => {
    expect(decideIntentCompletion({ status: "completed", declaredSize: 10, expiresAt: future }, null)).toEqual({
      action: "replay",
    })
  })

  it("410 when the URL expired before the file arrived", () => {
    const r = decideIntentCompletion({ status: "pending", declaredSize: 10, expiresAt: past }, null)
    expect(r).toMatchObject({ action: "reject", status: 410 })
  })

  it("409 when the file has not been uploaded yet", () => {
    const r = decideIntentCompletion({ status: "pending", declaredSize: 10, expiresAt: future }, null)
    expect(r).toMatchObject({ action: "reject", status: 409 })
  })

  it("422 when the uploaded size does not match", () => {
    const r = decideIntentCompletion(
      { status: "pending", declaredSize: 10, expiresAt: future },
      { size: 999, contentType: null },
    )
    expect(r).toMatchObject({ action: "reject", status: 422 })
  })
})

describe("decideMultipartCompletion", () => {
  const parts = (n: number) => Array.from({ length: n }, (_, i) => ({ partNumber: i + 1 }))

  it("completes when every part is present, de-duped and sorted", () => {
    const r = decideMultipartCompletion({
      status: "active",
      totalParts: 3,
      parts: [{ partNumber: 3 }, { partNumber: 1 }, { partNumber: 2 }, { partNumber: 2 }],
      connectionRevoked: false,
    })
    expect(r).toEqual({ action: "complete", partNumbers: [1, 2, 3] })
  })

  it("replays an already-completed upload", () => {
    expect(
      decideMultipartCompletion({ status: "completed", totalParts: 3, parts: parts(3), connectionRevoked: false }),
    ).toEqual({ action: "replay" })
  })

  it("rejects a cancelled/aborted upload", () => {
    const r = decideMultipartCompletion({ status: "aborted", totalParts: 3, parts: parts(3), connectionRevoked: false })
    expect(r).toMatchObject({ action: "reject", status: 409 })
  })

  it("rejects when the connection was revoked mid-upload", () => {
    const r = decideMultipartCompletion({ status: "active", totalParts: 3, parts: parts(3), connectionRevoked: true })
    expect(r).toMatchObject({ action: "reject", status: 409, error: expect.stringMatching(/revoked/i) })
  })

  it("reports missing chunks", () => {
    const r = decideMultipartCompletion({
      status: "active",
      totalParts: 3,
      parts: [{ partNumber: 1 }],
      connectionRevoked: false,
    })
    expect(r).toMatchObject({ action: "reject", status: 409, error: expect.stringMatching(/missing 2, 3/i) })
  })

  it("ignores out-of-range part numbers", () => {
    const r = decideMultipartCompletion({
      status: "active",
      totalParts: 2,
      parts: [{ partNumber: 1 }, { partNumber: 2 }, { partNumber: 99 }],
      connectionRevoked: false,
    })
    expect(r).toEqual({ action: "complete", partNumbers: [1, 2] })
  })
})
