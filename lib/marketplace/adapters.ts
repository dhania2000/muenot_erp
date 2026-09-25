import "server-only"
/**
 * Integration marketplace — REVIEWED server adapters (Spec 15, #88-89).
 * ---------------------------------------------------------------------------
 * SECURITY: connector behaviour lives ONLY here, in code that ships with the
 * app and has been reviewed. Tenant input never becomes executable connector
 * logic — the store resolves an adapter strictly by a catalogue key it has
 * already validated (lib/marketplace/connectors.ts), and each adapter reads
 * only the declared credential fields. There is no dynamic dispatch on, no
 * `eval` of, and no code path selected by tenant-supplied values.
 *
 * An adapter's `probe` performs a cheap, side-effect-free readiness check used
 * by install / reconnect (fail an install whose credentials are unusable) and
 * by the health endpoint. It returns a ProbeResult which the store maps to a
 * HealthState via `classifyHealth` from the shared vault provider layer.
 */
import type { ProbeResult } from "@/lib/secrets/providers/types"

/** Input handed to a reviewed adapter. Only declared credential fields appear. */
export type AdapterProbeInput = {
  credentials: Record<string, string>
  grantedScopes: string[]
}

export type ConnectorAdapter = {
  key: string
  /**
   * Validate that the supplied credentials are structurally usable. This is a
   * deterministic, offline check (shape/format only) — it never dials the
   * third party from this environment, so it is safe to run on every install
   * and health check without a network dependency or a way to smuggle in code.
   */
  probe(input: AdapterProbeInput): Promise<ProbeResult>
}

function ok(): ProbeResult {
  return { ok: true }
}

function fail(reason: string): ProbeResult {
  return { ok: false, detail: reason }
}

function nonEmpty(v: string | undefined | null): boolean {
  return typeof v === "string" && v.trim() !== ""
}

const tally: ConnectorAdapter = {
  key: "tally",
  async probe({ credentials }) {
    if (!nonEmpty(credentials.host)) return fail("Tally gateway host is missing")
    const port = Number(credentials.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return fail("Tally gateway port is invalid")
    if (!nonEmpty(credentials.auth_token)) return fail("Tally gateway auth token is missing")
    return ok()
  },
}

const zoho: ConnectorAdapter = {
  key: "zoho",
  async probe({ credentials }) {
    if (!nonEmpty(credentials.client_id)) return fail("Zoho client id is missing")
    if (!nonEmpty(credentials.client_secret)) return fail("Zoho client secret is missing")
    if (!nonEmpty(credentials.refresh_token)) return fail("Zoho refresh token is missing")
    const region = String(credentials.region ?? "").trim().toLowerCase()
    if (!["com", "in", "eu", "au", "jp"].includes(region)) return fail("Zoho region is invalid")
    return ok()
  },
}

const microsoft: ConnectorAdapter = {
  key: "microsoft",
  async probe({ credentials }) {
    if (!nonEmpty(credentials.directory_tenant_id)) return fail("Microsoft directory tenant id is missing")
    if (!nonEmpty(credentials.client_id)) return fail("Microsoft client id is missing")
    if (!nonEmpty(credentials.client_secret)) return fail("Microsoft client secret is missing")
    return ok()
  },
}

const google: ConnectorAdapter = {
  key: "google",
  async probe({ credentials }) {
    if (!nonEmpty(credentials.client_id)) return fail("Google client id is missing")
    if (!nonEmpty(credentials.client_secret)) return fail("Google client secret is missing")
    if (!nonEmpty(credentials.refresh_token)) return fail("Google refresh token is missing")
    return ok()
  },
}

const slack: ConnectorAdapter = {
  key: "slack",
  async probe({ credentials }) {
    if (!nonEmpty(credentials.app_id)) return fail("Slack app id is missing")
    if (!nonEmpty(credentials.bot_token)) return fail("Slack bot token is missing")
    if (!credentials.bot_token.startsWith("xoxb-")) return fail("Slack bot token must be a bot token (xoxb-…)")
    if (!nonEmpty(credentials.signing_secret)) return fail("Slack signing secret is missing")
    return ok()
  },
}

const ADAPTERS: Record<string, ConnectorAdapter> = {
  tally,
  zoho,
  microsoft,
  google,
  slack,
}

/**
 * Resolve the reviewed adapter for a connector's `adapter` key. Returns null
 * when no reviewed adapter exists — the store treats that as a hard error
 * rather than falling back to any dynamic behaviour.
 */
export function getAdapter(adapterKey: string): ConnectorAdapter | null {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, adapterKey) ? ADAPTERS[adapterKey] : null
}
