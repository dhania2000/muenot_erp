/**
 * API version registry + the v1 → v2 compatibility / migration policy.
 * ---------------------------------------------------------------------------
 * Versions are DATED (not "v1"/"v2" in the URL) so a caller pins behavior with
 * the `X-API-Version` header and the same `/api/v1/*` routes serve every
 * supported version. The friendly `label` ("v1", "v2") is only for humans.
 *
 * The single source of truth for:
 *   - which versions exist and their lifecycle status,
 *   - the DEFAULT applied when a caller sends no header,
 *   - the compatibility policy that governs what may change within a version
 *     versus what forces a new one,
 *   - the concrete response projection that upgrades a v1-shaped payload to v2
 *     ADDITIVELY (every v1 field is preserved), which is what makes v2 a
 *     backward-compatible migration rather than a break.
 *
 * `lib/api-platform/response.ts` re-exports `API_VERSION` / `SUPPORTED_VERSIONS`
 * from here so there is exactly one place that defines the version surface, and
 * the handler negotiates the effective version through `resolveApiVersion`.
 */

export type ApiVersion = "2024-10-01" | "2025-04-01"

/** v1 — the first published, currently-default contract. */
export const V1: ApiVersion = "2024-10-01"
/** v2 — additive successor; opt-in via the X-API-Version header. */
export const V2: ApiVersion = "2025-04-01"

/** Applied when a request omits `X-API-Version`. Kept at v1 so existing
 * integrations are never silently upgraded into v2 behavior. */
export const DEFAULT_API_VERSION: ApiVersion = V1
/** The newest published version. */
export const LATEST_API_VERSION: ApiVersion = V2

export type VersionStatus = "current" | "supported" | "deprecated" | "sunset"

export type VersionInfo = {
  version: ApiVersion
  label: string
  status: VersionStatus
  released: string
  /** Present once a version is scheduled for retirement. */
  deprecatedOn?: string
  sunsetOn?: string
  summary: string
}

export const API_VERSIONS: readonly VersionInfo[] = [
  {
    version: V1,
    label: "v1",
    status: "current",
    released: "2024-10-01",
    summary:
      "First stable public contract. Standard success/error envelopes, cursor-free page metadata, tenant-scoped resources.",
  },
  {
    version: V2,
    label: "v2",
    status: "supported",
    released: "2025-04-01",
    summary:
      "Additive successor. Adds a typed `object` discriminator and a stable `id` alias to every resource; all v1 fields are retained. Opt in with `X-API-Version: 2025-04-01`.",
  },
] as const

/** Fast membership test used by the request pipeline. */
export const SUPPORTED_API_VERSIONS: ReadonlySet<string> = new Set(API_VERSIONS.map((v) => v.version))

export function isSupportedVersion(value: string): value is ApiVersion {
  return SUPPORTED_API_VERSIONS.has(value)
}

export function versionInfo(version: ApiVersion): VersionInfo {
  return API_VERSIONS.find((v) => v.version === version) ?? API_VERSIONS[0]
}

export type VersionResolution = {
  /** The effective version the request runs under. */
  version: ApiVersion
  /** Whether the requested header (if any) was valid. */
  ok: boolean
  /** The raw requested header value, or null when omitted. */
  requested: string | null
}

/**
 * Negotiates the effective version from an `X-API-Version` header value.
 * Omitted → default (ok). Known → that version (ok). Unknown → default but
 * `ok:false` so the caller rejects with `unsupported_version` instead of
 * silently serving default behavior under a version the client did not expect.
 */
export function resolveApiVersion(requested: string | null | undefined): VersionResolution {
  if (!requested) return { version: DEFAULT_API_VERSION, ok: true, requested: null }
  const trimmed = requested.trim()
  if (isSupportedVersion(trimmed)) return { version: trimmed, ok: true, requested: trimmed }
  return { version: DEFAULT_API_VERSION, ok: false, requested: trimmed }
}

// ---------------------------------------------------------------------------
// Compatibility / migration policy
// ---------------------------------------------------------------------------

export type CompatibilityRule = {
  id: string
  since: ApiVersion
  kind: "additive" | "behavioral"
  description: string
}

/**
 * The published, machine-readable contract policy served at `/api/v1/versions`.
 * `principles` is the contract we promise integrators; `rules` is the concrete
 * changelog of what each dated version added.
 */
export const COMPATIBILITY_POLICY: {
  principles: string[]
  rules: CompatibilityRule[]
} = {
  principles: [
    "Within a dated version only additive, backward-compatible changes ship: new fields, new endpoints, new optional query parameters. Existing fields never change type or meaning.",
    "Breaking changes (removals, renames, type or semantic changes) require a new dated version and are strictly opt-in via the `X-API-Version` header.",
    "Omitting `X-API-Version` pins the current default version; sending an unknown value is rejected with `unsupported_version` rather than being silently coerced.",
    "A response is always tagged with the effective version via the `X-API-Version` header so a caller can assert what contract it received.",
    "Deprecated versions keep functioning until their published `sunset` date and advertise `Deprecation` and `Sunset` response headers in the interim.",
  ],
  rules: [
    {
      id: "v2-resource-object-discriminator",
      since: V2,
      kind: "additive",
      description:
        "Every resource gains an `object` string discriminator (e.g. \"client\") for polymorphic client handling. v1 responses omit it.",
    },
    {
      id: "v2-resource-id-alias",
      since: V2,
      kind: "additive",
      description:
        "Every resource gains a stable `id` alias mirroring its natural code (e.g. `client_code`). The original code field is retained for v1 compatibility.",
    },
  ],
}

/**
 * Projects a v1-shaped resource payload into the requested version's shape.
 * v1 is the identity. v2 layers additive fields on top WITHOUT removing any v1
 * field — this is what enforces "compatible migration": for any resource,
 * `v1Payload` is always a subset of `projectResource(V2, ..., v1Payload)`.
 *
 * `naturalKey` names the resource's natural identifier field so the `id` alias
 * can mirror it (defaults to `<resourceType>_code`).
 */
export function projectResource<T extends Record<string, unknown>>(
  version: ApiVersion,
  resourceType: string,
  payload: T,
  naturalKey?: string,
): T & { object?: string; id?: unknown } {
  if (version === V1) return payload
  const key = naturalKey ?? `${resourceType}_code`
  return { object: resourceType, id: payload[key], ...payload }
}

/** Projects a list of resources; convenience wrapper over `projectResource`. */
export function projectResources<T extends Record<string, unknown>>(
  version: ApiVersion,
  resourceType: string,
  payloads: T[],
  naturalKey?: string,
): Array<T & { object?: string; id?: unknown }> {
  if (version === V1) return payloads
  return payloads.map((p) => projectResource(version, resourceType, p, naturalKey))
}
