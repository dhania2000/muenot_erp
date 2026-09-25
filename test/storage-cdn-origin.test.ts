import { describe, expect, it } from "vitest"
import { cdnOriginUrl, cacheControlFor, mediaKindFor, isRangeable } from "@/lib/storage/cdn"

/**
 * Spec11 — provider-aware CDN origin selection.
 *
 * The single most important invariant: a private (signed/session) delivery is
 * NEVER rewritten onto the shared public CDN origin, so a private monitoring or
 * training video can never be cached publicly. Public objects MAY use the CDN
 * origin when one is configured, and fall back to the app proxy otherwise.
 */

const PROXY = "https://app.example.com/api/storage/file/tenant-7/large-uploads/training/lesson.mp4?sig=abc&exp=123"
const KEY = "tenant-7/large-uploads/training/lesson.mp4"
const CDN = "https://cdn.example.com"

describe("cdnOriginUrl — never leaks private sessions to a public CDN", () => {
  it("keeps a signed delivery on the signed proxy even when a CDN origin exists", () => {
    expect(
      cdnOriginUrl({ access: "signed", key: KEY, signedOrProxyUrl: PROXY, publicBaseUrl: CDN }),
    ).toBe(PROXY)
  })

  it("keeps a session (interactive) delivery on the proxy", () => {
    expect(
      cdnOriginUrl({ access: "session", key: KEY, signedOrProxyUrl: PROXY, publicBaseUrl: CDN }),
    ).toBe(PROXY)
  })

  it("routes a public object to the configured CDN origin", () => {
    expect(
      cdnOriginUrl({ access: "public", key: KEY, signedOrProxyUrl: PROXY, publicBaseUrl: CDN }),
    ).toBe(`${CDN}/${KEY}`)
  })

  it("normalizes slashes between origin and key", () => {
    expect(
      cdnOriginUrl({ access: "public", key: `/${KEY}`, signedOrProxyUrl: PROXY, publicBaseUrl: `${CDN}/` }),
    ).toBe(`${CDN}/${KEY}`)
  })

  it("falls back to the proxy for a public object when no CDN origin is configured", () => {
    expect(
      cdnOriginUrl({ access: "public", key: KEY, signedOrProxyUrl: PROXY, publicBaseUrl: null }),
    ).toBe(PROXY)
    expect(
      cdnOriginUrl({ access: "public", key: KEY, signedOrProxyUrl: PROXY, publicBaseUrl: "   " }),
    ).toBe(PROXY)
  })
})

describe("cache policy for private media streaming", () => {
  it("marks interactive session streams no-store (never shared-cached)", () => {
    expect(cacheControlFor({ access: "session", kind: "video" })).toContain("no-store")
    expect(cacheControlFor({ access: "session", kind: "video" })).toContain("private")
  })

  it("caps a signed stream's freshness at the token's remaining lifetime and keeps it private", () => {
    const cc = cacheControlFor({ access: "signed", kind: "video", remainingTtlSeconds: 120 })
    expect(cc).toBe("private, max-age=120")
  })

  it("allows shared immutable caching only for explicitly public media", () => {
    const cc = cacheControlFor({ access: "public", kind: "video" })
    expect(cc).toContain("public")
    expect(cc).toContain("immutable")
  })
})

describe("video/audio are seekable (Range)", () => {
  it("classifies by content-type then extension", () => {
    expect(mediaKindFor("video/mp4")).toBe("video")
    expect(mediaKindFor(null, "clip.webm")).toBe("video")
    expect(mediaKindFor("audio/mpeg")).toBe("audio")
    expect(mediaKindFor("image/png")).toBe("image")
  })

  it("marks video and audio as rangeable, others not", () => {
    expect(isRangeable("video")).toBe(true)
    expect(isRangeable("audio")).toBe(true)
    expect(isRangeable("image")).toBe(false)
    expect(isRangeable("document")).toBe(false)
  })
})
