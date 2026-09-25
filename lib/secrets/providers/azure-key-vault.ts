import "server-only"
import type { ProbeResult, VaultProvider, VaultReadResult, VaultWriteResult } from "./types"

/**
 * Azure Key Vault adapter.
 * ---------------------------------------------------------------------------
 * Talks to the Key Vault data-plane REST API
 * (`https://<vault>.vault.azure.net/secrets/...`) using an AAD bearer token
 * obtained via the OAuth2 client-credentials grant, behind the generic
 * `VaultProvider` contract. A real backend, no `@azure/*` SDK dependency.
 *
 * Fail-closed discipline mirrors the AWS adapter: every token/network error
 * REJECTS so the store falls back to the encrypted DB vault and records health.
 * Both the token fetch and the API call use injectable transports so the
 * adapter is unit-testable without touching Azure. Azure secret names allow
 * only [0-9A-Za-z-]; refs are sanitized to that alphabet.
 */

export type AzureHttpResponse = { status: number; body: string }
export type AzureApiTransport = (args: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}) => Promise<AzureHttpResponse>
/** Injectable token source: returns a bearer access token for the vault scope. */
export type AzureTokenProvider = (timeoutMs: number) => Promise<string>

export type AzureKeyVaultConfig = {
  /** Vault DNS name, e.g. "my-vault" or "my-vault.vault.azure.net". */
  vaultName: string
  tenantId: string
  clientId: string
  clientSecret: string
  apiVersion?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_API_VERSION = "7.4"

class AzureRequestError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
    readonly notFound = false,
  ) {
    super(message)
    this.name = "AzureRequestError"
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<AzureHttpResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return { status: res.status, body: await res.text() }
  } catch (err: any) {
    if (err?.name === "AbortError") throw new AzureRequestError(`Azure request timed out after ${timeoutMs}ms`, true)
    throw new AzureRequestError(`Azure request failed: ${err?.message ?? "network error"}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Azure secret names are restricted to [0-9A-Za-z-]; make any ref safe. */
export function azureSecretName(ref: string): string {
  const cleaned = ref.replace(/[^0-9A-Za-z-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
  return cleaned || "secret"
}

export class AzureKeyVaultProvider implements VaultProvider {
  readonly kind = "azure_key_vault" as const
  private readonly baseUrl: string
  private readonly apiVersion: string
  private readonly timeoutMs: number

  constructor(
    private readonly config: AzureKeyVaultConfig,
    private readonly api: AzureApiTransport = (a) =>
      fetchWithTimeout(a.url, { method: a.method, headers: a.headers, body: a.body }, a.timeoutMs),
    private readonly tokenProvider?: AzureTokenProvider,
  ) {
    const host = config.vaultName.includes(".") ? config.vaultName : `${config.vaultName}.vault.azure.net`
    this.baseUrl = `https://${host}`
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Default AAD client-credentials token grant against login.microsoftonline.com. */
  private defaultToken: AzureTokenProvider = async (timeoutMs) => {
    const url = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "client_credentials",
      scope: "https://vault.azure.net/.default",
    }).toString()
    const res = await fetchWithTimeout(
      url,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
      timeoutMs,
    )
    if (res.status < 200 || res.status >= 300) {
      throw new AzureRequestError(`Azure token request failed (${res.status})`)
    }
    const token = JSON.parse(res.body)?.access_token
    if (!token) throw new AzureRequestError("Azure token response had no access_token")
    return String(token)
  }

  private async bearer(): Promise<string> {
    const provider = this.tokenProvider ?? this.defaultToken
    return provider(this.timeoutMs)
  }

  private async call(method: string, path: string, payload?: Record<string, unknown>): Promise<any> {
    const token = await this.bearer()
    const url = `${this.baseUrl}${path}?api-version=${this.apiVersion}`
    const res = await this.api({
      url,
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      timeoutMs: this.timeoutMs,
    })
    if (res.status >= 200 && res.status < 300) return res.body ? JSON.parse(res.body) : {}
    const notFound = res.status === 404
    throw new AzureRequestError(`Azure ${method} ${path} failed (${res.status})`, false, notFound)
  }

  async putSecret(ref: string, value: string): Promise<VaultWriteResult> {
    const out = await this.call("PUT", `/secrets/${azureSecretName(ref)}`, { value })
    // Azure returns the version as the last id segment: .../secrets/<name>/<version>
    const id = String(out?.id ?? "")
    const providerVersion = id.split("/").pop() ?? ""
    return { providerVersion }
  }

  async getSecret(ref: string, providerVersion?: string | null): Promise<VaultReadResult> {
    const suffix = providerVersion ? `/${providerVersion}` : ""
    const out = await this.call("GET", `/secrets/${azureSecretName(ref)}${suffix}`)
    const value = typeof out?.value === "string" ? out.value : null
    if (value == null) throw new AzureRequestError("Azure secret has no value")
    const id = String(out?.id ?? "")
    return { value, providerVersion: id.split("/").pop() ?? null }
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now()
    try {
      // Listing a single secret exercises token acquisition + data-plane auth.
      await this.call("GET", "/secrets")
      return { ok: true, latencyMs: Date.now() - started }
    } catch (err) {
      const e = err as AzureRequestError
      return { ok: false, timedOut: !!e.timedOut, detail: e.message, latencyMs: Date.now() - started }
    }
  }
}
