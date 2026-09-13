import "server-only"

// ---------------------------------------------------------------------------
// IFSC → bank / branch resolution (server-only).
//
// Wraps the public Razorpay IFSC directory (GET https://ifsc.razorpay.com/{IFSC}).
// No API key is required. The IFSC format is validated locally first so a typo
// never triggers a network call, requests time out quickly, and successful
// lookups are cached in-process for a short window to avoid repeat calls during
// a single form session.
// ---------------------------------------------------------------------------

const BASE_URL = "https://ifsc.razorpay.com"
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour — IFSC records rarely change
const REQUEST_TIMEOUT_MS = 8000

export type IfscData = {
  ifsc: string
  bank: string
  branch: string
  address: string
  city: string
  district: string
  state: string
  micr: string | null
}

export type IfscResult = {
  state: "verified" | "invalid" | "not_found" | "error"
  ok: boolean
  message?: string
  data?: IfscData
  cached?: boolean
}

/** Uppercase and strip whitespace so lookups and the cache key are consistent. */
export function normalizeIfsc(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "")
}

/** True when the value matches the 11-character IFSC shape (5th char is 0). */
export function isValidIfscFormat(ifsc: string): boolean {
  return IFSC_REGEX.test(ifsc)
}

const cache = new Map<string, { at: number; data: IfscData }>()

export async function lookupIfsc(raw: string): Promise<IfscResult> {
  const ifsc = normalizeIfsc(raw)
  if (!isValidIfscFormat(ifsc)) {
    return { state: "invalid", ok: false, message: "Enter a valid 11-character IFSC." }
  }

  const hit = cache.get(ifsc)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { state: "verified", ok: true, data: hit.data, cached: true }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}/${ifsc}`, { signal: controller.signal })
    if (res.status === 404) {
      return { state: "not_found", ok: false, message: "No bank branch found for this IFSC." }
    }
    if (!res.ok) {
      return { state: "error", ok: false, message: "Lookup service is unavailable right now." }
    }
    const j = (await res.json()) as Record<string, unknown>
    const data: IfscData = {
      ifsc,
      bank: str(j.BANK),
      branch: str(j.BRANCH),
      address: str(j.ADDRESS),
      city: str(j.CITY),
      district: str(j.DISTRICT),
      state: str(j.STATE),
      micr: j.MICR ? String(j.MICR) : null,
    }
    cache.set(ifsc, { at: Date.now(), data })
    return { state: "verified", ok: true, data }
  } catch {
    return { state: "error", ok: false, message: "Could not reach the IFSC lookup service." }
  } finally {
    clearTimeout(timer)
  }
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v)
}
