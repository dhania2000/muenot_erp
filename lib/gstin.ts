import "server-only"

// ---------------------------------------------------------------------------
// GSTIN verification (server-only).
//
// Wraps the gstinapi.in REST API (GET /v1/gstin/{gstin}). The API key lives in
// GSTIN_API_KEY and is NEVER exposed to the browser — every call goes through a
// server route that imports this module. Format is validated locally first so a
// typo cannot spend a credit, transient failures (429/502) are retried with
// exponential backoff, and successful lookups are cached in-process for a short
// window to avoid re-charging for the same GSTIN during a single form session.
// ---------------------------------------------------------------------------

const BASE_URL = "https://www.gstinapi.in"
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const REQUEST_TIMEOUT_MS = 9000

/** GST state code → state / union-territory name (first two GSTIN digits). */
export const GST_STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (Old)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
}

export function normalizeGstin(input: string | null | undefined): string {
  return String(input ?? "").trim().toUpperCase().replace(/\s+/g, "")
}

export function isValidGstinFormat(gstin: string): boolean {
  return GSTIN_REGEX.test(normalizeGstin(gstin))
}

/** The PAN is embedded in positions 3-12 of a valid GSTIN. */
export function panFromGstin(gstin: string): string | null {
  const g = normalizeGstin(gstin)
  return isValidGstinFormat(g) ? g.slice(2, 12) : null
}

export function stateCodeFromGstin(gstin: string): string | null {
  const g = normalizeGstin(gstin)
  const two = g.slice(0, 2)
  return /^\d{2}$/.test(two) ? two : null
}

export function stateNameFromGstin(gstin: string): string | null {
  const code = stateCodeFromGstin(gstin)
  return code ? GST_STATE_CODES[code] ?? null : null
}

export type GstinVerifyState =
  | "verified" // active taxpayer
  | "verified_inactive" // real GSTIN, but cancelled / suspended / inactive
  | "invalid" // failed format/checksum or provider says invalid
  | "not_found" // GSTIN not registered in the GST database
  | "no_credits" // account out of credits
  | "unauthorized" // missing / invalid key or deactivated account
  | "rate_limited" // 429 after retries
  | "unavailable" // provider temporarily down / network error
  | "not_configured" // GSTIN_API_KEY missing
  | "error"

export type GstinData = {
  gstin: string
  legalName: string | null
  tradeName: string | null
  status: string | null
  taxpayerType: string | null
  businessConstitution: string | null
  registrationDate: string | null
  cancellationDate: string | null
  blockStatus: string | null
  stateCode: string | null
  stateName: string | null
  address: string | null
  city: string | null
  pincode: string | null
}

export type GstinVerifyResult = {
  state: GstinVerifyState
  ok: boolean
  message: string
  gstin: string
  data: GstinData | null
  creditsRemaining: number | null
  cached: boolean
}

type CacheEntry = { result: GstinVerifyResult; expires: number }
const cache = new Map<string, CacheEntry>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mapState(status: string | null): GstinVerifyState {
  const s = (status ?? "").toLowerCase()
  if (!s) return "verified"
  if (s.includes("active") && !s.includes("inactive")) return "verified"
  return "verified_inactive"
}

async function callProvider(gstin: string, apiKey: string): Promise<GstinVerifyResult> {
  let lastError = "GST provider temporarily unavailable."
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(`${BASE_URL}/v1/gstin/${gstin}`, {
        headers: { "x-api-key": apiKey, accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      })
      clearTimeout(timer)

      // Only 429 (rate limit) and 502 (provider down) are safe to retry.
      if (res.status === 429 || res.status === 502) {
        lastError =
          res.status === 429
            ? "Rate limit exceeded. Please retry in a moment."
            : "GST provider temporarily unavailable. Please retry."
        await sleep(400 * 2 ** attempt)
        continue
      }

      const body = (await res.json().catch(() => ({}))) as any
      const creditsRemaining = typeof body?.credits_remaining === "number" ? body.credits_remaining : null

      if (res.status === 200 && body?.success) {
        const d = body.data ?? {}
        const stateCode = d.state_code ?? stateCodeFromGstin(gstin)
        const data: GstinData = {
          gstin: d.gstin ?? gstin,
          legalName: d.legal_name ?? null,
          tradeName: d.trade_name ?? null,
          status: d.status ?? null,
          taxpayerType: d.taxpayer_type ?? null,
          businessConstitution: d.business_constitution ?? null,
          registrationDate: d.registration_date ?? null,
          cancellationDate: d.cancellation_date ?? null,
          blockStatus: d.block_status ?? null,
          stateCode: stateCode ?? null,
          stateName: stateCode ? GST_STATE_CODES[stateCode] ?? null : stateNameFromGstin(gstin),
          address: d.address ?? null,
          city: d.city ?? null,
          pincode: d.pincode ?? d.address_details?.pincode ?? null,
        }
        const state = mapState(data.status)
        return {
          state,
          ok: true,
          message:
            state === "verified"
              ? "GSTIN verified — active taxpayer."
              : `GSTIN found but marked ${data.status ?? "inactive"}.`,
          gstin,
          data,
          creditsRemaining,
          cached: false,
        }
      }

      const message = body?.error || "Unable to verify this GSTIN."
      const state: GstinVerifyState =
        res.status === 400
          ? "invalid"
          : res.status === 401 || res.status === 403
            ? "unauthorized"
            : res.status === 402
              ? "no_credits"
              : res.status === 404
                ? "not_found"
                : "error"
      return { state, ok: false, message, gstin, data: null, creditsRemaining, cached: false }
    } catch (error) {
      clearTimeout(timer)
      lastError = (error as Error).name === "AbortError" ? "GST verification timed out." : "Network error reaching the GST provider."
      await sleep(400 * 2 ** attempt)
    }
  }
  return { state: "unavailable", ok: false, message: lastError, gstin, data: null, creditsRemaining: null, cached: false }
}

export async function verifyGstin(rawGstin: string): Promise<GstinVerifyResult> {
  const gstin = normalizeGstin(rawGstin)

  if (!isValidGstinFormat(gstin)) {
    return {
      state: "invalid",
      ok: false,
      message: "Invalid GSTIN format. Expected 15 characters like 22AAAAA0000A1Z5.",
      gstin,
      data: null,
      creditsRemaining: null,
      cached: false,
    }
  }

  const apiKey = process.env.GSTIN_API_KEY
  if (!apiKey) {
    return {
      state: "not_configured",
      ok: false,
      message: "GSTIN verification is not configured (missing API key).",
      gstin,
      data: null,
      creditsRemaining: null,
      cached: false,
    }
  }

  const now = Date.now()
  const hit = cache.get(gstin)
  if (hit && hit.expires > now) return { ...hit.result, cached: true }

  const result = await callProvider(gstin, apiKey)

  // Only cache authoritative outcomes; never cache transient failures so a retry
  // can succeed. Invalid / not-found are stable answers and safe to cache.
  if (result.ok || result.state === "invalid" || result.state === "not_found") {
    cache.set(gstin, { result, expires: now + CACHE_TTL_MS })
  }
  return result
}

/**
 * Persisted vendor verification label derived from a verification result. This
 * is the authoritative status the server stores — never trust a client value.
 */
export function verificationStatusLabel(result: GstinVerifyResult): string {
  switch (result.state) {
    case "verified":
      return "Verified"
    case "verified_inactive": {
      const s = (result.data?.status ?? "").toLowerCase()
      if (s.includes("cancel")) return "Cancelled"
      if (s.includes("suspend")) return "Suspended"
      if (s.includes("provisional")) return "Provisional"
      return "Inactive"
    }
    case "not_found":
      return "Not Found"
    case "invalid":
      return "Invalid"
    default:
      return "Unverified"
  }
}

/** Map the GST taxpayer type to the vendor master's registration-type options. */
export function registrationTypeFromTaxpayer(taxpayerType: string | null): string | null {
  const t = (taxpayerType ?? "").toLowerCase()
  if (!t) return null
  if (t.includes("composition")) return "Composition"
  if (t.includes("sez")) return "SEZ"
  if (t.includes("regular") || t.includes("input") || t.includes("tax")) return "Regular"
  return null
}
