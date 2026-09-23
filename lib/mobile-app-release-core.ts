export const SHOPKEEPER_APP = "muenot-shopkeeper"
export const ANDROID = "android"

export type ReleaseInput = {
  application: string; platform: string; versionName: string; versionCode: number;
  minimumVersionCode: number; apkUrl: string | null; apkSize: number | null;
  apkSha256: string | null; releaseNotes: string[]; forceUpdate: boolean
}

export class ReleaseValidationError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

function positiveInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null
}

export function validateApkUrl(value: string, allowedHosts = ""): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/\.apk$/i.test(url.pathname)) return false
    const hosts = allowedHosts.split(",").map(host => host.trim().toLowerCase()).filter(Boolean)
    return !hosts.length || hosts.includes(url.hostname.toLowerCase())
  } catch { return false }
}

export function parseReleaseInput(value: unknown, options: { publish?: boolean; allowedHosts?: string } = {}): ReleaseInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReleaseValidationError("Release must be an object.")
  const data = value as Record<string, unknown>
  const application = typeof data.application === "string" ? data.application.trim() : SHOPKEEPER_APP
  const platform = typeof data.platform === "string" ? data.platform.trim() : ANDROID
  if (application !== SHOPKEEPER_APP || platform !== ANDROID) throw new ReleaseValidationError("Unsupported application or platform.")
  const versionName = typeof data.versionName === "string" ? data.versionName.trim() : ""
  if (!versionName || versionName.length > 64 || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(versionName)) throw new ReleaseValidationError("A valid version name is required.")
  const versionCode = positiveInteger(data.versionCode)
  if (!versionCode) throw new ReleaseValidationError("Version code must be a positive integer.")
  const minimumVersionCode = positiveInteger(data.minimumVersionCode)
  if (!minimumVersionCode || minimumVersionCode > versionCode) throw new ReleaseValidationError("Minimum supported version code must be positive and at most the release version code.")
  const apkUrl = typeof data.apkUrl === "string" ? data.apkUrl.trim() || null : null
  const apkSize = data.apkSize == null || data.apkSize === "" ? null : positiveInteger(data.apkSize)
  if (data.apkSize != null && data.apkSize !== "" && !apkSize) throw new ReleaseValidationError("APK size must be a positive integer in bytes.")
  const apkSha256 = typeof data.apkSha256 === "string" ? data.apkSha256.trim().toLowerCase() || null : null
  if (apkSha256 && !/^[a-f0-9]{64}$/.test(apkSha256)) throw new ReleaseValidationError("APK SHA-256 must be 64 hexadecimal characters.")
  if (apkUrl && (apkUrl.length > 2048 || !validateApkUrl(apkUrl, options.allowedHosts))) throw new ReleaseValidationError("APK URL must be an allowed immutable HTTPS .apk URL without query or fragment.")
  if (options.publish && (!apkUrl || !apkSize || !apkSha256)) throw new ReleaseValidationError("APK URL, size and SHA-256 are required before publishing.")
  if (!Array.isArray(data.releaseNotes) || data.releaseNotes.length > 30 || data.releaseNotes.some(note => typeof note !== "string" || !note.trim() || note.length > 500)) throw new ReleaseValidationError("Release notes must be an array of up to 30 nonempty lines.")
  if (typeof data.forceUpdate !== "boolean") throw new ReleaseValidationError("Force update must be a boolean.")
  return { application, platform, versionName, versionCode, minimumVersionCode, apkUrl, apkSize, apkSha256, releaseNotes: data.releaseNotes.map(note => (note as string).trim()), forceUpdate: data.forceUpdate }
}

export function updatePolicy(installedVersionCode: number, release: Pick<ReleaseInput, "versionCode" | "minimumVersionCode" | "forceUpdate">): "none" | "optional" | "mandatory" {
  if (installedVersionCode >= release.versionCode) return "none"
  if (installedVersionCode < release.minimumVersionCode || release.forceUpdate) return "mandatory"
  return "optional"
}
