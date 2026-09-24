/**
 * Tenant database routing model (pure, DB-free, Node-free).
 * ---------------------------------------------------------------------------
 * Every tenant is served by exactly one of three deployment models:
 *
 *   shared_database   — one physical database shared by all tenants; isolation
 *                       is row-level via `tenant_id` (the existing default).
 *   separate_schema   — the shared server, but a per-tenant MySQL schema
 *                       (database) so a tenant's tables are physically separate.
 *   dedicated_database— an entirely separate database instance whose connection
 *                       details live behind a managed secret reference.
 *
 * This module owns the pure decision logic: which model a tenant uses, how a
 * connection PROFILE is derived from trusted tenant configuration (never client
 * input), the stable POOL KEY that guarantees no cross-tenant connection reuse,
 * and the validation of routing settings. The actual pools, secret resolution
 * and DB writes live in the server-only modules alongside it.
 */

import { detectRegionDrift, isDataRegion, regionsCompatible } from "./regions"

// ---------------------------------------------------------------------------
// Deployment models
// ---------------------------------------------------------------------------

export const DEPLOYMENT_MODELS = ["shared_database", "separate_schema", "dedicated_database"] as const
export type DeploymentModel = (typeof DEPLOYMENT_MODELS)[number]

export const DEPLOYMENT_MODEL_LABELS: Record<DeploymentModel, string> = {
  shared_database: "Shared database (row-level isolation)",
  separate_schema: "Separate schema (per-tenant database on shared server)",
  dedicated_database: "Dedicated database (isolated instance)",
}

export function isDeploymentModel(value: unknown): value is DeploymentModel {
  return typeof value === "string" && (DEPLOYMENT_MODELS as readonly string[]).includes(value)
}

export function toDeploymentModel(value: unknown): DeploymentModel | null {
  return isDeploymentModel(value) ? value : null
}

/** True when the model routes to a connection distinct from the shared pool. */
export function isolatesConnection(model: DeploymentModel): boolean {
  return model !== "shared_database"
}

/** True when the model requires a managed secret reference (its own instance). */
export function requiresConnectionRef(model: DeploymentModel): boolean {
  return model === "dedicated_database"
}

/** True when the model requires a dedicated per-tenant schema name. */
export function requiresSchema(model: DeploymentModel): boolean {
  return model === "separate_schema" || model === "dedicated_database"
}

// ---------------------------------------------------------------------------
// Provisioning + health lifecycle
// ---------------------------------------------------------------------------

export const PROVISION_STATUSES = ["unprovisioned", "provisioning", "active", "migrating", "failed"] as const
export type ProvisionStatus = (typeof PROVISION_STATUSES)[number]

export function toProvisionStatus(value: unknown): ProvisionStatus {
  return (PROVISION_STATUSES as readonly string[]).includes(value as string)
    ? (value as ProvisionStatus)
    : "unprovisioned"
}

export const HEALTH_STATUSES = ["unknown", "healthy", "unhealthy"] as const
export type HealthStatus = (typeof HEALTH_STATUSES)[number]

export function toHealthStatus(value: unknown): HealthStatus {
  return (HEALTH_STATUSES as readonly string[]).includes(value as string) ? (value as HealthStatus) : "unknown"
}

// ---------------------------------------------------------------------------
// Connection profile — the resolved routing decision for one tenant
// ---------------------------------------------------------------------------

/**
 * The trusted inputs a profile is derived from. These come exclusively from the
 * tenant record and its routing registry (server-side source of truth), never
 * from a request body.
 */
export type ProfileInputs = {
  tenantId: number
  deploymentModel: DeploymentModel
  /** Per-tenant schema/database name (separate_schema / dedicated_database). */
  schema?: string | null
  /** Managed secret reference that yields the dedicated DSN. */
  connectionRef?: string | null
  /** The region this tenant's database is configured for. */
  dbRegion?: string | null
  /** The tenant's residency anchor, used to enforce region compatibility. */
  dataRegion?: string | null
}

export type ConnectionProfile = {
  tenantId: number
  deploymentModel: DeploymentModel
  schema: string | null
  connectionRef: string | null
  /** The region this connection MUST resolve to. */
  region: string | null
  /** Stable key identifying the pool that serves this profile. */
  poolKey: string
}

export class TenantRoutingError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "TenantRoutingError"
    this.status = status
  }
}

export class CrossTenantConnectionError extends Error {
  constructor(message = "Refusing to reuse another tenant's database connection.") {
    super(message)
    this.name = "CrossTenantConnectionError"
  }
}

export class RegionDriftError extends Error {
  expected: string | null
  actual: string | null
  constructor(message: string, expected: string | null, actual: string | null) {
    super(message)
    this.name = "RegionDriftError"
    this.expected = expected
    this.actual = actual
  }
}

const SCHEMA_RE = /^[a-zA-Z0-9_]{1,64}$/

/** A safe MySQL identifier for a schema name — rejects anything backtick-unsafe. */
export function isValidSchemaName(value: unknown): value is string {
  return typeof value === "string" && SCHEMA_RE.test(value)
}

/**
 * Compute the stable pool key for a profile. This is the linchpin of
 * "no cross-tenant connection reuse":
 *
 *   - shared_database  → a single shared key per region. Reuse ACROSS tenants
 *     here is intentional and safe (row-level `tenant_id` isolation).
 *   - separate_schema  → keyed by tenant + schema + region, so two tenants can
 *     never land on the same schema pool.
 *   - dedicated_database→ keyed by tenant + connection ref + region, so a
 *     dedicated pool is bound to exactly one tenant for its whole lifetime.
 */
export function poolKeyForProfile(inputs: ProfileInputs): string {
  const region = inputs.dbRegion ?? "default"
  switch (inputs.deploymentModel) {
    case "shared_database":
      return `shared::${region}`
    case "separate_schema":
      return `schema::${inputs.tenantId}::${inputs.schema ?? ""}::${region}`
    case "dedicated_database":
      return `dedicated::${inputs.tenantId}::${inputs.connectionRef ?? ""}::${region}`
    default:
      return `shared::${region}`
  }
}

/**
 * Resolve a tenant's routing configuration into a connection profile, enforcing
 * every invariant that can be checked without touching the network:
 *
 *   - separate_schema / dedicated_database MUST carry a valid schema name.
 *   - dedicated_database MUST carry a connection reference.
 *   - when both a data-region anchor and a db-region are set, the db-region MUST
 *     be residency-compatible with the anchor.
 *
 * Throws TenantRoutingError on any violation so a misconfigured tenant fails
 * closed instead of silently falling back to the shared database.
 */
export function resolveConnectionProfile(inputs: ProfileInputs): ConnectionProfile {
  const { tenantId, deploymentModel } = inputs
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new TenantRoutingError("A valid tenant id is required to resolve a connection.", 400)
  }
  if (!isDeploymentModel(deploymentModel)) {
    throw new TenantRoutingError(`Unknown deployment model "${deploymentModel}".`, 400)
  }

  const schema = inputs.schema?.trim() || null
  const connectionRef = inputs.connectionRef?.trim() || null
  const region = inputs.dbRegion?.trim() || null

  if (requiresSchema(deploymentModel)) {
    if (!schema) {
      throw new TenantRoutingError(
        `Deployment model "${deploymentModel}" requires a per-tenant schema name.`,
        409,
      )
    }
    if (!isValidSchemaName(schema)) {
      throw new TenantRoutingError(`Schema name "${schema}" is not a valid MySQL identifier.`, 400)
    }
  }

  if (requiresConnectionRef(deploymentModel) && !connectionRef) {
    throw new TenantRoutingError(
      "A dedicated database requires a managed connection secret reference.",
      409,
    )
  }

  if (region && inputs.dataRegion && isDataRegion(inputs.dataRegion)) {
    if (!regionsCompatible(inputs.dataRegion, region)) {
      throw new TenantRoutingError(
        `Database region "${region}" violates the tenant's data residency (${inputs.dataRegion}).`,
        409,
      )
    }
  }

  return {
    tenantId,
    deploymentModel,
    schema,
    connectionRef,
    region,
    poolKey: poolKeyForProfile({ ...inputs, schema, connectionRef, dbRegion: region }),
  }
}

/**
 * Assert a cached pool may serve this profile. Guards two ways a pool could be
 * wrongly reused: a key collision that maps two tenants onto one isolated pool
 * (cross-tenant reuse) and a region mismatch on the same key (region drift).
 */
export function assertPoolUsable(
  profile: ConnectionProfile,
  cached: { tenantId: number; region: string | null; deploymentModel: DeploymentModel },
): void {
  // Isolated models are bound to a single tenant for their whole lifetime.
  if (isolatesConnection(profile.deploymentModel) && cached.tenantId !== profile.tenantId) {
    throw new CrossTenantConnectionError(
      `Pool ${profile.poolKey} is bound to tenant ${cached.tenantId}, refusing to serve tenant ${profile.tenantId}.`,
    )
  }
  const drift = detectRegionDrift(profile.region, cached.region)
  if (drift.drifted) {
    throw new RegionDriftError(drift.message ?? "Region drift detected.", drift.expected, drift.actual)
  }
}

// ---------------------------------------------------------------------------
// Settings validation (for the platform API)
// ---------------------------------------------------------------------------

export type RoutingSettingsInput = {
  deploymentModel?: unknown
  schema?: unknown
  connectionRef?: unknown
  dbRegion?: unknown
}

export type RoutingFieldError = { field: string; message: string }

/** Validate operator-supplied routing settings before persisting them. */
export function validateRoutingSettings(
  input: RoutingSettingsInput,
  dataRegion: string | null | undefined,
): RoutingFieldError[] {
  const errors: RoutingFieldError[] = []
  const model = toDeploymentModel(input.deploymentModel)
  if (input.deploymentModel !== undefined && model == null) {
    errors.push({ field: "deploymentModel", message: "Unknown deployment model." })
  }

  const effectiveModel = model ?? "shared_database"

  if (input.schema !== undefined && input.schema !== null && input.schema !== "") {
    if (!isValidSchemaName(input.schema)) {
      errors.push({ field: "schema", message: "Schema must be 1-64 chars: letters, digits or underscore." })
    }
  } else if (requiresSchema(effectiveModel) && model != null) {
    errors.push({ field: "schema", message: `${DEPLOYMENT_MODEL_LABELS[effectiveModel]} requires a schema name.` })
  }

  if (requiresConnectionRef(effectiveModel) && model != null) {
    const ref = typeof input.connectionRef === "string" ? input.connectionRef.trim() : ""
    if (!ref) {
      errors.push({ field: "connectionRef", message: "A dedicated database requires a connection secret reference." })
    }
  }
  if (input.connectionRef !== undefined && input.connectionRef !== null && input.connectionRef !== "") {
    if (typeof input.connectionRef !== "string" || !/^[A-Za-z0-9_.-]{1,190}$/.test(input.connectionRef)) {
      errors.push({
        field: "connectionRef",
        message: "Connection reference must be 1-190 chars: letters, digits, dot, dash or underscore.",
      })
    }
  }

  if (input.dbRegion !== undefined && input.dbRegion !== null && input.dbRegion !== "") {
    if (!isDataRegion(input.dbRegion)) {
      errors.push({ field: "dbRegion", message: "Unknown database region." })
    } else if (dataRegion && isDataRegion(dataRegion) && !regionsCompatible(dataRegion, input.dbRegion)) {
      errors.push({
        field: "dbRegion",
        message: `Database region violates the tenant's data residency (${dataRegion}).`,
      })
    }
  }

  return errors
}
