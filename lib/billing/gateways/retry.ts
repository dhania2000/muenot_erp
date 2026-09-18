/**
 * SPEC 21 — Transport retry + error classification (shared by adapters).
 * ---------------------------------------------------------------------------
 * Payment APIs fail transiently (network blips, 429s, 5xx). We retry those
 * with exponential backoff, but NEVER retry a definitive decline or a client
 * error (4xx other than 429) — retrying those cannot succeed and, without an
 * idempotency key, could double-charge. `GatewayError.retryable` carries that
 * decision so `withRetry` stays provider-agnostic.
 */

export class GatewayError extends Error {
  /** Whether another attempt could plausibly succeed. */
  readonly retryable: boolean
  /** HTTP status when the failure came from the provider API. */
  readonly status?: number
  readonly gateway?: string
  readonly code?: string

  constructor(
    message: string,
    opts: { retryable?: boolean; status?: number; gateway?: string; code?: string; cause?: unknown } = {},
  ) {
    super(message)
    this.name = "GatewayError"
    this.retryable = opts.retryable ?? false
    this.status = opts.status
    this.gateway = opts.gateway
    this.code = opts.code
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause
  }
}

/** 429 and 5xx are worth retrying; every other status is terminal. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

export type RetryOptions = {
  /** Total attempts including the first (default 3). */
  attempts?: number
  /** Base backoff in ms; doubles each retry (default 200). */
  baseDelayMs?: number
  /** Backoff ceiling in ms (default 5000). */
  maxDelayMs?: number
  /** Injectable sleep so tests run without real timers. */
  sleep?: (ms: number) => Promise<void>
  /** Observe each retry (logging/metrics/tests). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run `fn` up to `attempts` times, backing off between retries. Stops
 * immediately on a non-retryable `GatewayError`. Unknown errors (e.g. a thrown
 * `TypeError` from `fetch` on a dropped connection) are treated as retryable.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const base = opts.baseDelayMs ?? 200
  const max = opts.maxDelayMs ?? 5000
  const sleep = opts.sleep ?? defaultSleep

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      const retryable = error instanceof GatewayError ? error.retryable : true
      if (!retryable || attempt === attempts) break
      const delayMs = Math.min(max, base * 2 ** (attempt - 1))
      opts.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }
  throw lastError
}
