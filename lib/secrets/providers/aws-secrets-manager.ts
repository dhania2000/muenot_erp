import "server-only"
import { type AwsCredentials, signAwsRequest } from "./aws-sigv4"
import type { ProbeResult, VaultProvider, VaultReadResult, VaultWriteResult } from "./types"

/**
 * AWS Secrets Manager adapter.
 * ---------------------------------------------------------------------------
 * Talks to the Secrets Manager JSON RPC endpoint
 * (`secretsmanager.<region>.amazonaws.com`) with SigV4-signed POSTs, behind the
 * generic `VaultProvider` contract. A real backend, no AWS SDK dependency.
 *
 * Fail-closed discipline: every network/auth error REJECTS (never resolves a
 * bogus "clean" value and never throws synchronously), so the store falls back
 * to the encrypted DB vault and records a degraded/down health instead of
 * leaking or losing a tenant secret. The HTTP transport is injectable so the
 * adapter is fully unit-testable without touching AWS.
 */

export type AwsHttpResponse = { status: number; body: string }
/** Injectable transport: performs the signed HTTP POST and returns status+body. */
export type AwsTransport = (args: {
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
}) => Promise<AwsHttpResponse>

export type AwsSecretsManagerConfig = {
  region: string
  credentials: AwsCredentials
  /** Optional name prefix so tenant secrets live under a namespace, e.g. "muenot/". */
  prefix?: string
  timeoutMs?: number
  now?: () => Date
}

const DEFAULT_TIMEOUT_MS = 10_000
const TARGET = "secretsmanager.AWSSecretsManagerV20170817"

class AwsRequestError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
    readonly notFound = false,
  ) {
    super(message)
    this.name = "AwsRequestError"
  }
}

/** Default transport backed by global fetch with an AbortController deadline. */
const fetchTransport: AwsTransport = async ({ url, headers, body, timeoutMs }) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal })
    return { status: res.status, body: await res.text() }
  } catch (err: any) {
    if (err?.name === "AbortError") throw new AwsRequestError(`AWS request timed out after ${timeoutMs}ms`, true)
    throw new AwsRequestError(`AWS request failed: ${err?.message ?? "network error"}`)
  } finally {
    clearTimeout(timer)
  }
}

export class AwsSecretsManagerProvider implements VaultProvider {
  readonly kind = "aws_secrets_manager" as const
  private readonly host: string
  private readonly url: string
  private readonly timeoutMs: number

  constructor(
    private readonly config: AwsSecretsManagerConfig,
    private readonly transport: AwsTransport = fetchTransport,
  ) {
    this.host = `secretsmanager.${config.region}.amazonaws.com`
    this.url = `https://${this.host}/`
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private secretId(ref: string): string {
    const prefix = this.config.prefix ?? ""
    return prefix ? `${prefix.replace(/\/+$/, "")}/${ref}` : ref
  }

  private async call(action: string, payload: Record<string, unknown>): Promise<any> {
    const body = JSON.stringify(payload)
    const headers = signAwsRequest(
      {
        method: "POST",
        host: this.host,
        region: this.config.region,
        service: "secretsmanager",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `${TARGET}.${action}`,
        },
        body,
        now: this.config.now?.(),
      },
      this.config.credentials,
    )
    const res = await this.transport({ url: this.url, headers, body, timeoutMs: this.timeoutMs })
    if (res.status >= 200 && res.status < 300) {
      return res.body ? JSON.parse(res.body) : {}
    }
    let type = ""
    try {
      type = String(JSON.parse(res.body)?.__type ?? "")
    } catch {
      /* non-JSON error body */
    }
    const notFound = /ResourceNotFoundException/i.test(type) || res.status === 404
    throw new AwsRequestError(`AWS ${action} failed (${res.status})${type ? `: ${type}` : ""}`, false, notFound)
  }

  async putSecret(ref: string, value: string): Promise<VaultWriteResult> {
    const SecretId = this.secretId(ref)
    // Try an in-place new version first; if the secret does not exist yet, create it.
    try {
      const out = await this.call("PutSecretValue", { SecretId, SecretString: value })
      return { providerVersion: String(out?.VersionId ?? "") }
    } catch (err) {
      if (err instanceof AwsRequestError && err.notFound) {
        const created = await this.call("CreateSecret", { Name: SecretId, SecretString: value })
        return { providerVersion: String(created?.VersionId ?? "") }
      }
      throw err
    }
  }

  async getSecret(ref: string, providerVersion?: string | null): Promise<VaultReadResult> {
    const payload: Record<string, unknown> = { SecretId: this.secretId(ref) }
    if (providerVersion) payload.VersionId = providerVersion
    const out = await this.call("GetSecretValue", payload)
    const value = typeof out?.SecretString === "string" ? out.SecretString : null
    if (value == null) throw new AwsRequestError("AWS secret has no string value")
    return { value, providerVersion: out?.VersionId ? String(out.VersionId) : null }
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now()
    try {
      // ListSecrets with a tiny page is the cheapest auth+reachability check.
      await this.call("ListSecrets", { MaxResults: 1 })
      return { ok: true, latencyMs: Date.now() - started }
    } catch (err) {
      const e = err as AwsRequestError
      return { ok: false, timedOut: !!e.timedOut, detail: e.message, latencyMs: Date.now() - started }
    }
  }
}
