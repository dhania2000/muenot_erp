import { describe, expect, it } from "vitest"
import { parseReleaseInput, updatePolicy, validateApkUrl } from "@/lib/mobile-app-release-core"

const release = { application: "muenot-shopkeeper", platform: "android", versionName: "1.0.1", versionCode: 2, minimumVersionCode: 1, apkUrl: "https://downloads.muenot.co.in/muenot-shopkeeper-1.0.1.apk", apkSize: 48000000, apkSha256: "a".repeat(64), releaseNotes: ["Improved inbox"], forceUpdate: false }

describe("mobile app release validation", () => {
  it("accepts a complete reviewed release", () => expect(parseReleaseInput(release, { publish: true })).toEqual(release))
  it("permits an incomplete draft but not publication", () => {
    const draft = { ...release, apkUrl: "", apkSize: null, apkSha256: "" }
    expect(parseReleaseInput(draft).apkUrl).toBeNull()
    expect(() => parseReleaseInput(draft, { publish: true })).toThrow(/required/)
  })
  it.each([0, -1, 1.5, "1.5", Number.MAX_SAFE_INTEGER])("rejects invalid versionCode %s", versionCode => expect(() => parseReleaseInput({ ...release, versionCode })).toThrow())
  it("rejects an invalid minimum supported version", () => expect(() => parseReleaseInput({ ...release, minimumVersionCode: 3 })).toThrow())
  it("requires HTTPS, APK suffix, no query and optional host allowlist", () => {
    expect(validateApkUrl("http://downloads.muenot.co.in/a.apk")).toBe(false)
    expect(validateApkUrl("https://downloads.muenot.co.in/a.apk?token=secret")).toBe(false)
    expect(validateApkUrl("https://downloads.muenot.co.in/a.zip")).toBe(false)
    expect(validateApkUrl(release.apkUrl, "other.example")).toBe(false)
    expect(validateApkUrl(release.apkUrl, "downloads.muenot.co.in")).toBe(true)
  })
  it("rejects malformed SHA-256", () => expect(() => parseReleaseInput({ ...release, apkSha256: "bad" })).toThrow(/SHA-256/))
  it("does not permit another app or platform in this phase", () => expect(() => parseReleaseInput({ ...release, application: "another-app" })).toThrow())
})

describe("Android update policy", () => {
  it("uses versionCode, minimumVersionCode and forceUpdate in order", () => {
    expect(updatePolicy(3, { versionCode: 3, minimumVersionCode: 2, forceUpdate: true })).toBe("none")
    expect(updatePolicy(2, { versionCode: 3, minimumVersionCode: 2, forceUpdate: false })).toBe("optional")
    expect(updatePolicy(1, { versionCode: 3, minimumVersionCode: 2, forceUpdate: false })).toBe("mandatory")
    expect(updatePolicy(2, { versionCode: 3, minimumVersionCode: 2, forceUpdate: true })).toBe("mandatory")
  })
})
