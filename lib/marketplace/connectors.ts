/**
 * Integration marketplace — PURE connector model (Spec 15, #88-89).
 * ---------------------------------------------------------------------------
 * An installable CONNECTOR is a curated third-party integration (Tally, Zoho,
 * Microsoft, Google, Slack) a tenant can install into its workspace. This
 * module is the DB-free, network-free core the store + API + UI build on:
 *
 *   • the connector CATALOGUE — every connector declares a COMMON manifest of
 *     scopes (what access it asks for), credentials (what it needs to connect)
 *     and events (what it can emit), plus the name of the REVIEWED server
 *     adapter that backs it. A connector never carries executable tenant input;
 *     the adapter is selected by this validated catalogue key alone;
 *   • validation of connector keys, requested scopes and supplied credentials;
 *   • the install lifecycle state machine (install / reconnect / disconnect);
 *   • the masked, secret-free PUBLIC projection + a fail-closed no-exposure
 *     invariant, the permission-review projection, and a deterministic
 *     idempotency-key derivation for write actions.
 *
 * Mirrors the conventions of the tenant integration-secrets model
 * (lib/secrets/tenant-integrations.ts) so the two subsystems stay consistent.
 */
import type { HealthState } from "@/lib/secrets/providers/types"

export type ConnectorCategory = "accounting" | "productivity" | "identity" | "communication"

/** One OAuth-style permission scope a connector requests. */
export type ConnectorScope = {
  key: string
  label: string
  description: string
  /** Required scopes are always granted on install; optional ones are opt-in. */
  required?: boolean
}

/** One credential field a connector needs to establish its connection. */
export type ConnectorCredentialField = {
  key: string
  label: string
  /** Secret fields are encrypted at rest and NEVER returned to a client. */
  secret: boolean
  /** Required fields must be supplied (non-empty) to install / reconnect. */
  required: boolean
  hint?: string
}

/** One business event a connector can emit into the ERP. */
export type ConnectorEvent = {
  key: string
  label: string
  description: string
}

/** The COMMON manifest every connector in the catalogue conforms to. */
export type ConnectorManifest = {
  key: string
  name: string
  category: ConnectorCategory
  description: string
  /**
   * The reviewed, server-side adapter that backs this connector. The store
   * resolves the adapter by THIS key (never by tenant input), so tenant-supplied
   * data can never select or execute arbitrary connector code.
   */
  adapter: string
  scopes: readonly ConnectorScope[]
  credentials: readonly ConnectorCredentialField[]
  events: readonly ConnectorEvent[]
  docsUrl?: string
}

/**
 * The catalogue of installable connectors. Deliberately curated: each entry is
 * backed by a reviewed adapter (lib/marketplace/adapters.ts).
 */
export const CONNECTORS: readonly ConnectorManifest[] = [
  {
    key: "tally",
    name: "Tally",
    category: "accounting",
    description: "Sync ledgers and vouchers with a Tally Prime / ERP 9 gateway.",
    adapter: "tally",
    scopes: [
      { key: "ledgers.read", label: "Read ledgers", description: "Read the chart of ledgers.", required: true },
      { key: "vouchers.read", label: "Read vouchers", description: "Read accounting vouchers.", required: true },
      { key: "vouchers.write", label: "Post vouchers", description: "Create vouchers in Tally." },
      { key: "masters.sync", label: "Sync masters", description: "Sync stock items and groups." },
    ],
    credentials: [
      { key: "host", label: "Gateway host", secret: false, required: true, hint: "e.g. 192.168.0.10" },
      { key: "port", label: "Gateway port", secret: false, required: true, hint: "e.g. 9000" },
      { key: "company_name", label: "Company name", secret: false, required: false },
      { key: "auth_token", label: "Gateway auth token", secret: true, required: true },
    ],
    events: [
      { key: "voucher.created", label: "Voucher created", description: "A voucher was posted in Tally." },
      { key: "ledger.updated", label: "Ledger updated", description: "A ledger master changed." },
      { key: "sync.completed", label: "Sync completed", description: "A scheduled sync finished." },
    ],
  },
  {
    key: "zoho",
    name: "Zoho",
    category: "productivity",
    description: "Connect Zoho CRM and Books for records, contacts and invoices.",
    adapter: "zoho",
    scopes: [
      { key: "crm.read", label: "Read CRM", description: "Read CRM records.", required: true },
      { key: "crm.write", label: "Write CRM", description: "Create and update CRM records." },
      { key: "books.read", label: "Read Books", description: "Read Books invoices and contacts.", required: true },
      { key: "books.write", label: "Write Books", description: "Create Books invoices." },
    ],
    credentials: [
      { key: "client_id", label: "Client ID", secret: false, required: true },
      { key: "client_secret", label: "Client secret", secret: true, required: true },
      { key: "refresh_token", label: "Refresh token", secret: true, required: true },
      { key: "region", label: "Data center region", secret: false, required: true, hint: "com | in | eu" },
    ],
    events: [
      { key: "record.created", label: "Record created", description: "A CRM/Books record was created." },
      { key: "record.updated", label: "Record updated", description: "A CRM/Books record changed." },
      { key: "webhook.received", label: "Webhook received", description: "Zoho pushed a webhook." },
    ],
  },
  {
    key: "microsoft",
    name: "Microsoft 365",
    category: "identity",
    description: "Microsoft Graph access to mail, calendar and files via Entra ID.",
    adapter: "microsoft",
    scopes: [
      { key: "user.read", label: "Read profile", description: "Read the signed-in user's profile.", required: true },
      { key: "offline_access", label: "Offline access", description: "Refresh tokens for background sync.", required: true },
      { key: "mail.read", label: "Read mail", description: "Read the user's mail." },
      { key: "calendars.read", label: "Read calendar", description: "Read calendar events." },
      { key: "files.read", label: "Read files", description: "Read OneDrive / SharePoint files." },
    ],
    credentials: [
      { key: "directory_tenant_id", label: "Directory (tenant) ID", secret: false, required: true },
      { key: "client_id", label: "Application (client) ID", secret: false, required: true },
      { key: "client_secret", label: "Client secret", secret: true, required: true },
      { key: "refresh_token", label: "Refresh token", secret: true, required: false },
    ],
    events: [
      { key: "mail.received", label: "Mail received", description: "A new message arrived." },
      { key: "event.created", label: "Calendar event created", description: "A calendar event was created." },
      { key: "file.changed", label: "File changed", description: "A drive item changed." },
    ],
  },
  {
    key: "google",
    name: "Google Workspace",
    category: "identity",
    description: "Google APIs for Drive, Calendar and Gmail via OAuth.",
    adapter: "google",
    scopes: [
      { key: "userinfo.email", label: "Read email", description: "Read the account email.", required: true },
      { key: "offline_access", label: "Offline access", description: "Refresh tokens for background sync.", required: true },
      { key: "drive.readonly", label: "Read Drive", description: "Read Drive files." },
      { key: "calendar.readonly", label: "Read Calendar", description: "Read calendar events." },
      { key: "gmail.readonly", label: "Read Gmail", description: "Read Gmail messages." },
    ],
    credentials: [
      { key: "client_id", label: "Client ID", secret: false, required: true },
      { key: "client_secret", label: "Client secret", secret: true, required: true },
      { key: "refresh_token", label: "Refresh token", secret: true, required: true },
    ],
    events: [
      { key: "file.changed", label: "Drive file changed", description: "A Drive file changed." },
      { key: "event.created", label: "Calendar event created", description: "A calendar event was created." },
      { key: "message.received", label: "Gmail message received", description: "A new Gmail message arrived." },
    ],
  },
  {
    key: "slack",
    name: "Slack",
    category: "communication",
    description: "Post messages and receive events from a Slack workspace.",
    adapter: "slack",
    scopes: [
      { key: "chat:write", label: "Post messages", description: "Send messages as the app.", required: true },
      { key: "channels:read", label: "Read channels", description: "List public channels.", required: true },
      { key: "users:read", label: "Read users", description: "Read workspace users." },
      { key: "im:write", label: "Direct messages", description: "Open and write DMs." },
    ],
    credentials: [
      { key: "app_id", label: "App ID", secret: false, required: true },
      { key: "bot_token", label: "Bot token", secret: true, required: true, hint: "xoxb-…" },
      { key: "signing_secret", label: "Signing secret", secret: true, required: true },
    ],
    events: [
      { key: "message.channels", label: "Channel message", description: "A message was posted to a channel." },
      { key: "app_mention", label: "App mentioned", description: "The app was @-mentioned." },
      { key: "reaction_added", label: "Reaction added", description: "A reaction was added." },
    ],
  },
] as const

const BY_KEY = new Map(CONNECTORS.map((c) => [c.key, c]))

export function getConnector(key: string): ConnectorManifest | null {
  return BY_KEY.get(key) ?? null
}

export function isKnownConnector(key: string): boolean {
  return BY_KEY.has(key)
}

export function listConnectorKeys(): string[] {
  return CONNECTORS.map((c) => c.key)
}

// ---------------------------------------------------------------------------
// Scope + credential validation
// ---------------------------------------------------------------------------

/**
 * Resolve the scopes a tenant is granted for a connector. Every REQUIRED scope
 * is always included; requested OPTIONAL scopes must exist in the manifest.
 * Unknown scopes are rejected so a tenant can never widen access beyond what
 * the reviewed manifest declares. Returns a de-duplicated, manifest-ordered list.
 */
export type ScopeResolution = { ok: true; granted: string[] } | { ok: false; error: string }

export function resolveGrantedScopes(connectorKey: string, requested?: readonly string[] | null): ScopeResolution {
  const manifest = BY_KEY.get(connectorKey)
  if (!manifest) return { ok: false, error: `Unknown connector "${connectorKey}"` }
  const known = new Set(manifest.scopes.map((s) => s.key))
  const req = new Set((requested ?? []).map((s) => String(s)))
  for (const s of req) {
    if (!known.has(s)) return { ok: false, error: `Unknown scope "${s}" for "${connectorKey}"` }
  }
  const granted = manifest.scopes
    .filter((s) => s.required || req.has(s.key))
    .map((s) => s.key)
  return { ok: true, granted }
}

/**
 * Validate a supplied credential map against the manifest: every required field
 * must be present + non-empty, and every supplied key must be a declared field.
 * Returns the accepted keys (secret + non-secret) so the store knows what to
 * persist. Never inspects a value beyond emptiness — no plaintext leaves here.
 */
export type CredentialValidation = { ok: true; keys: string[] } | { ok: false; error: string }

export function validateConnectorCredentials(
  connectorKey: string,
  provided: Record<string, unknown>,
): CredentialValidation {
  const manifest = BY_KEY.get(connectorKey)
  if (!manifest) return { ok: false, error: `Unknown connector "${connectorKey}"` }
  const declared = new Map(manifest.credentials.map((f) => [f.key, f]))
  const suppliedKeys = Object.keys(provided ?? {})
  for (const k of suppliedKeys) {
    if (!declared.has(k)) return { ok: false, error: `Unknown credential field "${k}" for "${connectorKey}"` }
  }
  for (const field of manifest.credentials) {
    if (!field.required) continue
    const raw = provided?.[field.key]
    if (raw == null || String(raw).trim() === "") {
      return { ok: false, error: `Credential "${field.label}" is required` }
    }
  }
  // Persist every supplied field that carries a non-empty value.
  const keys = suppliedKeys.filter((k) => provided[k] != null && String(provided[k]).trim() !== "")
  return { ok: true, keys }
}

export function isSecretField(connectorKey: string, fieldKey: string): boolean {
  return BY_KEY.get(connectorKey)?.credentials.find((f) => f.key === fieldKey)?.secret ?? false
}

// ---------------------------------------------------------------------------
// Install lifecycle
// ---------------------------------------------------------------------------

export type InstallStatus = "not_installed" | "installed" | "disconnected"
export type ConnectorAction = "install" | "reconnect" | "disconnect" | "health"

export type TransitionDecision = { ok: true } | { ok: false; reason: string }

/**
 * The install-lifecycle state machine (pure, so it is unit-tested directly):
 *   • install    : from not_installed / disconnected → installed.
 *   • reconnect  : from installed / disconnected → installed (re-auth).
 *   • disconnect : from installed → disconnected (revokes credentials).
 *   • health     : only meaningful while installed.
 */
export function canTransition(current: InstallStatus, action: ConnectorAction): TransitionDecision {
  switch (action) {
    case "install":
      if (current === "installed") return { ok: false, reason: "Connector is already installed" }
      return { ok: true }
    case "reconnect":
      if (current === "not_installed") return { ok: false, reason: "Install the connector before reconnecting" }
      return { ok: true }
    case "disconnect":
      if (current !== "installed") return { ok: false, reason: "Connector is not installed" }
      return { ok: true }
    case "health":
      if (current !== "installed") return { ok: false, reason: "Connector is not installed" }
      return { ok: true }
    default:
      return { ok: false, reason: "Unknown action" }
  }
}

// ---------------------------------------------------------------------------
// Permission review
// ---------------------------------------------------------------------------

export type ScopeReview = {
  key: string
  label: string
  description: string
  required: boolean
  granted: boolean
}

/** Project a connector's manifest scopes against the granted set for review. */
export function reviewConnectorPermissions(connectorKey: string, grantedScopes: readonly string[]): ScopeReview[] {
  const manifest = BY_KEY.get(connectorKey)
  if (!manifest) return []
  const granted = new Set(grantedScopes.map((s) => String(s)))
  return manifest.scopes.map((s) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    required: !!s.required,
    granted: granted.has(s.key),
  }))
}

// ---------------------------------------------------------------------------
// Public (masked, secret-free) projection
// ---------------------------------------------------------------------------

export type PublicConnectorCredential = {
  key: string
  label: string
  secret: boolean
  required: boolean
  /** Whether an (encrypted) value is currently held. NEVER the value itself. */
  present: boolean
}

export type PublicConnector = {
  key: string
  name: string
  category: ConnectorCategory
  description: string
  adapter: string
  status: InstallStatus
  health: HealthState
  scopes: ScopeReview[]
  events: ConnectorEvent[]
  credentials: PublicConnectorCredential[]
  installedAt: string | null
  lastConnectedAt: string | null
  lastHealthAt: string | null
  lastError: string | null
}

/** The persisted install state the store feeds into the projection. */
export type ConnectorState = {
  status: InstallStatus
  health: HealthState
  grantedScopes: string[]
  /** Set of credential field keys that currently have an active value. */
  presentCredentials: Set<string> | string[]
  installedAt: string | null
  lastConnectedAt: string | null
  lastHealthAt: string | null
  lastError: string | null
}

export function toPublicConnector(manifest: ConnectorManifest, state: ConnectorState): PublicConnector {
  const present = state.presentCredentials instanceof Set ? state.presentCredentials : new Set(state.presentCredentials)
  return {
    key: manifest.key,
    name: manifest.name,
    category: manifest.category,
    description: manifest.description,
    adapter: manifest.adapter,
    status: state.status,
    health: state.health,
    scopes: reviewConnectorPermissions(manifest.key, state.grantedScopes),
    events: manifest.events.map((e) => ({ ...e })),
    credentials: manifest.credentials.map((f) => ({
      key: f.key,
      label: f.label,
      secret: f.secret,
      required: f.required,
      present: present.has(f.key),
    })),
    installedAt: state.installedAt,
    lastConnectedAt: state.lastConnectedAt,
    lastHealthAt: state.lastHealthAt,
    lastError: state.lastError,
  }
}

/**
 * Fail-closed invariant: the public projection must never carry a credential
 * value. Returns true when safe, throws otherwise. Mirrors the tenant-secrets
 * no-exposure guard so a regression is caught before it leaves the server.
 */
export function assertNoConnectorSecretExposure(connectors: PublicConnector[]): true {
  for (const c of connectors) {
    for (const f of c.credentials) {
      if ("value" in (f as Record<string, unknown>) || "plaintext" in (f as Record<string, unknown>)) {
        throw new Error(`Connector "${c.key}.${f.key}" exposed a plaintext credential`)
      }
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic idempotency key for a write action. Includes the
 * tenant so a key can NEVER collapse two tenants' actions together, plus the
 * connector and action. A client key disambiguates distinct intents.
 */
export function deriveConnectorIdempotencyKey(input: {
  tenantId: number
  connectorKey: string
  action: ConnectorAction
  clientKey?: string | null
}): string {
  const { tenantId, connectorKey, action, clientKey } = input
  const base = `${tenantId}:${connectorKey}:${action}`
  return clientKey ? `${base}:${clientKey}` : base
}
