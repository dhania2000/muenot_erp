import "server-only"
/**
 * Breached-password detection via the Have I Been Pwned "range" API using
 * k-anonymity — the plaintext password NEVER leaves the process.
 * ---------------------------------------------------------------------------
 * We SHA-1 the candidate password locally, then send only the first 5 hex
 * characters of that hash to the provider. The provider returns every suffix
 * that shares the prefix (typically a few hundred), and we match the remaining
 * 35 characters locally. The provider therefore never sees the password, the
 * full hash, or which specific entry (if any) matched.
 *
 * The check is advisory and MUST fail open: a provider outage, timeout, or
 * malformed response returns `{ checked: false }` so a sign-up / password
 * change is never blocked by an unreachable third party. Callers decide whether
 * to warn, require a different password, or raise a security alert only when
 * `checked === true && breached === true`.
 */
import crypto from "node:crypto"

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/"
const DEFAULT_TIMEOUT_MS = 3000

export type BreachCheckResult = {
  /** False when the provider could not be consulted (outage/timeout) — fail-open. */
  checked: boolean
  /** True only when the password appears in a known breach corpus. */
  breached: boolean
  /** How many times the password has been seen in breaches (0 when unknown/none). */
  count: number
}

export type BreachCheckOptions = {
  /** Injectable fetch for tests / custom transports. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Abort the range request after this many ms (fail-open). */
  timeoutMs?: number
}

/**
 * Checks whether `password` appears in the HIBP breach corpus without ever
 * transmitting the plaintext or full hash. Returns a fail-open result on any
 * provider error.
 */
export async function checkPasswordBreached(
  password: string,
  options: BreachCheckOptions = {},
): Promise<BreachCheckResult> {
  if (!password) return { checked: true, breached: false, count: 0 }

  const fetchImpl = options.fetchImpl ?? fetch
  const sha1 = crypto.createHash("sha1").update(password, "utf8").digest("hex").toUpperCase()
  const prefix = sha1.slice(0, 5)
  const suffix = sha1.slice(5)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${HIBP_RANGE_URL}${prefix}`, {
      // "Add-Padding" makes every response a uniform size so a network observer
      // cannot infer the breach status from the response length.
      headers: { "Add-Padding": "true" },
      signal: controller.signal,
    })
    if (!res || !res.ok) return { checked: false, breached: false, count: 0 }

    const text = await res.text()
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim()
      if (!line) continue
      const sepIndex = line.indexOf(":")
      if (sepIndex < 0) continue
      const hashSuffix = line.slice(0, sepIndex).toUpperCase()
      if (hashSuffix !== suffix) continue
      const count = Number.parseInt(line.slice(sepIndex + 1), 10) || 0
      // Padding entries are injected with a count of 0 — never a real breach.
      return { checked: true, breached: count > 0, count }
    }
    return { checked: true, breached: false, count: 0 }
  } catch {
    // Timeout, DNS failure, abort, non-JSON body — fail open.
    return { checked: false, breached: false, count: 0 }
  } finally {
    clearTimeout(timeout)
  }
}
