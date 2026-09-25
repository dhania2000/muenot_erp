/**
 * Spec16 — Integration sync: provider + entity registry (#90-91).
 * ---------------------------------------------------------------------------
 * A "sync source" is one (provider × entity) pairing a tenant can configure,
 * e.g. Zoho vendors → tenant `cost_centers`, Tally cost centres → `cost_centers`.
 * This module is the REVIEWED allow-list of those pairings. It declares, for
 * each source:
 *
 *   • the canonical master (MasterKind) the provider records normalize INTO, so
 *     every synced record lands in centralized master data (Spec 90) rather
 *     than a bespoke table;
 *   • a `normalize()` that turns one raw provider payload into the shared
 *     NormalizedRecord shape the engine reasons about;
 *   • a `PageFetcher` the engine calls to page through the provider.
 *
 * The engine (lib/integration-sync/store.ts) is otherwise provider-agnostic: it
 * only ever sees NormalizedRecord + ProviderPage, which is why every rule is
 * unit-testable with an injected fetcher and no live network.
 */
import type { MasterKind } from "@/lib/master-data/types"
import { clampPageSize, type NormalizedRecord, type ProviderPage, SyncError } from "@/lib/integration-sync/model"

/** How the engine asks a provider for the next page. Injectable for tests. */
export type PageFetcher = (input: {
  tenantId: number
  /** Opaque provider position from the previous page (or null to start). */
  cursor: string | null
  limit: number
  /** Provider-scoped credentials/config resolved by the store (never secrets in logs). */
  config: Record<string, unknown>
  signal?: AbortSignal
}) => Promise<ProviderPage>

export type SyncSourceDescriptor = {
  providerKey: string
  entityKind: string
  label: string
  /** Canonical master these records normalize into. Must be writable. */
  masterKind: MasterKind
  /** Turn a raw provider row into the normalized master shape. Throws SyncError
   * ("validation") when the row cannot yield a stable code/name. */
  normalize: (raw: Record<string, unknown>) => NormalizedRecord
}

const str = (v: unknown): string => (v == null ? "" : String(v)).trim()
const bool = (v: unknown, dflt = true): boolean => {
  if (v == null) return dflt
  if (typeof v === "boolean") return v
  const s = String(v).toLowerCase()
  return !(s === "false" || s === "0" || s === "no" || s === "inactive" || s === "archived")
}

/** Shared normalizer for the common {code,name,active,parent} provider shape. */
function normalizeGeneric(raw: Record<string, unknown>): NormalizedRecord {
  const code = str(raw.code ?? raw.id ?? raw.key ?? raw.number).toUpperCase()
  const name = str(raw.name ?? raw.title ?? raw.label ?? raw.display_name)
  if (!code) throw new SyncError("provider record is missing a stable code/id", "validation")
  if (!name) throw new SyncError(`provider record ${code} is missing a name`, "validation")
  const meta: Record<string, unknown> = {}
  if (raw.description != null) meta.description = str(raw.description)
  if (raw.external_updated_at != null) meta.external_updated_at = str(raw.external_updated_at)
  return {
    code: code.slice(0, 40),
    name: name.slice(0, 160),
    active: bool(raw.active ?? raw.status),
    parent: raw.parent != null ? str(raw.parent).toUpperCase().slice(0, 40) : null,
    meta,
  }
}

/**
 * The reviewed source catalogue. Each entry pairs a marketplace connector
 * (Spec 15) with a tenant master. `custom` accepts the generic shape so a
 * tenant can model a bespoke feed without a code change.
 */
export const SYNC_SOURCES: readonly SyncSourceDescriptor[] = [
  { providerKey: "tally", entityKind: "cost_centers", label: "Tally cost centres", masterKind: "cost_centers", normalize: normalizeGeneric },
  { providerKey: "zoho", entityKind: "cost_centers", label: "Zoho cost centres", masterKind: "cost_centers", normalize: normalizeGeneric },
  { providerKey: "zoho", entityKind: "categories", label: "Zoho item categories", masterKind: "categories", normalize: normalizeGeneric },
  { providerKey: "microsoft", entityKind: "locations", label: "Microsoft office locations", masterKind: "locations", normalize: normalizeGeneric },
  { providerKey: "custom", entityKind: "cost_centers", label: "Custom → cost centres", masterKind: "cost_centers", normalize: normalizeGeneric },
  { providerKey: "custom", entityKind: "categories", label: "Custom → categories", masterKind: "categories", normalize: normalizeGeneric },
  { providerKey: "custom", entityKind: "locations", label: "Custom → locations", masterKind: "locations", normalize: normalizeGeneric },
] as const

const BY_KEY = new Map(SYNC_SOURCES.map((s) => [`${s.providerKey}:${s.entityKind}`, s]))

export function getSyncSource(providerKey: string, entityKind: string): SyncSourceDescriptor | null {
  return BY_KEY.get(`${providerKey}:${entityKind}`) ?? null
}

export function requireSyncSource(providerKey: string, entityKind: string): SyncSourceDescriptor {
  const src = getSyncSource(providerKey, entityKind)
  if (!src) throw new SyncError(`No sync source registered for ${providerKey}/${entityKind}`, "config")
  return src
}

export function isKnownSource(providerKey: string, entityKind: string): boolean {
  return BY_KEY.has(`${providerKey}:${entityKind}`)
}

/** The reviewed source catalogue as plain options for the settings UI/API. */
export function listSyncSources(): Array<{ providerKey: string; entityKind: string; label: string; masterKind: MasterKind }> {
  return SYNC_SOURCES.map((s) => ({ providerKey: s.providerKey, entityKind: s.entityKind, label: s.label, masterKind: s.masterKind }))
}

// ---------------------------------------------------------------------------
// Live fetcher resolution
// ---------------------------------------------------------------------------

/**
 * No first-party live provider adapter ships with this spec — the engine is
 * driven either by an INJECTED fetcher (tests, and the store's replay path) or,
 * in production, by a fetcher registered here per provider once its adapter
 * exists. Until one is registered the connection fails closed with a clear
 * "outage/config" error rather than silently syncing nothing, so operators see
 * that the feed needs wiring instead of assuming an empty upstream.
 */
const LIVE_FETCHERS = new Map<string, PageFetcher>()

export function registerLiveFetcher(providerKey: string, fetcher: PageFetcher): void {
  LIVE_FETCHERS.set(providerKey, fetcher)
}

export function resolveFetcher(providerKey: string): PageFetcher {
  const fetcher = LIVE_FETCHERS.get(providerKey)
  if (fetcher) return fetcher
  return async () => {
    throw new SyncError(
      `Provider "${providerKey}" has no live data adapter configured on this deployment.`,
      "outage",
    )
  }
}

export { clampPageSize }
