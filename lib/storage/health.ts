import "server-only"
import type { HealthCheckId, HealthCheckResult, HealthCheckStatus, HealthReport } from "./types"

/**
 * Shared plumbing for provider health diagnostics.
 * ---------------------------------------------------------------------------
 * Providers describe WHAT to probe; this module handles the bookkeeping —
 * timing each probe, catching errors, turning them into actionable messages,
 * and assembling an ordered report. Kept provider-agnostic.
 */

export const HEALTH_CHECK_LABELS: Record<HealthCheckId, string> = {
  connectivity: "Connectivity",
  credentials: "Credentials",
  bucket: "Bucket access",
  write: "Write",
  read: "Read",
  delete: "Delete",
  multipart: "Multipart uploads",
}

/** Canonical display order regardless of the order probes actually ran. */
const HEALTH_CHECK_ORDER: HealthCheckId[] = [
  "connectivity",
  "credentials",
  "bucket",
  "write",
  "read",
  "delete",
  "multipart",
]

/**
 * Turn a thrown storage error into a short, human-actionable sentence. Maps the
 * common S3/network error names to plain language and appends the HTTP status
 * when present so admins can act without reading a stack trace.
 */
export function describeError(err: unknown): string {
  const e = err as any
  const name: string = e?.name || e?.Code || ""
  const status: number | undefined = e?.$metadata?.httpStatusCode
  const raw: string = e?.message || String(err)
  const map: Record<string, string> = {
    InvalidAccessKeyId: "Access key ID is not recognized",
    SignatureDoesNotMatch: "Secret access key is incorrect",
    CredentialsProviderError: "Missing or invalid credentials",
    InvalidToken: "Session token is invalid",
    ExpiredToken: "Credentials have expired",
    NoSuchBucket: "Bucket does not exist",
    NotFound: "Bucket or object not found",
    AccessDenied: "Access denied — check the bucket policy / IAM permissions",
    Forbidden: "Access denied — check the bucket policy / IAM permissions",
    AllAccessDisabled: "Access to this bucket is disabled",
    PermanentRedirect: "Wrong region for this bucket",
    AuthorizationHeaderMalformed: "Wrong region for this bucket",
    TimeoutError: "Connection timed out",
  }
  let msg = (name && map[name]) || raw
  if (status) msg += ` (HTTP ${status})`
  return String(msg).slice(0, 240)
}

/**
 * Accumulates individual check results and produces an ordered {@link HealthReport}.
 * `run()` executes a probe with timing + error handling; `pass`/`fail`/`skip`
 * record results the provider already knows about.
 */
export class HealthReportBuilder {
  private readonly checks: HealthCheckResult[] = []

  private push(id: HealthCheckId, status: HealthCheckStatus, detail: string | null, durationMs: number) {
    this.checks.push({ id, label: HEALTH_CHECK_LABELS[id], status, detail, durationMs })
  }

  pass(id: HealthCheckId, detail: string | null = null, durationMs = 0) {
    this.push(id, "pass", detail, durationMs)
  }

  fail(id: HealthCheckId, detail: string | null, durationMs = 0) {
    this.push(id, "fail", detail, durationMs)
  }

  skip(id: HealthCheckId, detail: string | null) {
    this.push(id, "skip", detail, 0)
  }

  /** Run a probe, timing it and recording pass/fail. Returns whether it passed. */
  async run(id: HealthCheckId, fn: () => Promise<string | null | void>): Promise<boolean> {
    const start = Date.now()
    try {
      const detail = await fn()
      this.push(id, "pass", (detail as string) ?? null, Date.now() - start)
      return true
    } catch (err) {
      this.push(id, "fail", describeError(err), Date.now() - start)
      return false
    }
  }

  build(): HealthReport {
    const checks = [...this.checks].sort(
      (a, b) => HEALTH_CHECK_ORDER.indexOf(a.id) - HEALTH_CHECK_ORDER.indexOf(b.id),
    )
    return { ok: checks.every((c) => c.status !== "fail"), checks }
  }
}
