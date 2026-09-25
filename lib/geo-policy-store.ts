import "server-only"
/**
 * Tenant geo (country) policy — server store (Spec25 · #213).
 * ---------------------------------------------------------------------------
 * Persists one country policy per tenant and enforces it at sign-in using a
 * TRUSTED geolocation (resolved by the edge from the real connecting IP — see
 * lib/geo.ts). The pure allow/block/unknown decision lives in
 * lib/geo-policy-core.ts; this layer adds persistence, tenant scoping, the
 * audited emergency-access escape hatch, and security-audit logging.
 *
 * Self-heals its schema at runtime (same pattern as the other security stores)
 * so existing databases converge with no manual migration step. The durable
 * schema is also in database/migrations/2027-01-17-spec25-geo-device-export.sql.
 */
import { query } from "@/lib/db"
import { recordSecurityEvent } from "@/lib/security-audit-store"
import {
  type GeoPolicy,
  type GeoDecision,
  evaluateGeoPolicy,
  normalizeCountry,
  normalizeCountryList,
} from "@/lib/geo-policy-core"

export type TenantGeoPolicy = GeoPolicy & {
  tenantId: number
  emergencyAccess: boolean
  updatedBy: number | null
  updatedAt: string | null
}

type GeoRow = {
  tenant_id: number
  enabled: number
  mode: "allow" | "block"
  countries: string | null
  unknown_action: "block" | "allow"
  emergency_access: number
  updated_by: number | null
  updated_at: string | null
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`tenant_geo_policies\` (
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`enabled\` TINYINT(1) NOT NULL DEFAULT 0,
      \`mode\` ENUM('allow','block') NOT NULL DEFAULT 'allow',
      \`countries\` JSON DEFAULT NULL,
      \`unknown_action\` ENUM('block','allow') NOT NULL DEFAULT 'block',
      \`emergency_access\` TINYINT(1) NOT NULL DEFAULT 0,
      \`updated_by\` INT UNSIGNED DEFAULT NULL,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureGeoPolicySchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

const DISABLED_DEFAULT: Omit<TenantGeoPolicy, "tenantId"> = {
  enabled: false,
  mode: "allow",
  countries: [],
  unknownAction: "block",
  emergencyAccess: false,
  updatedBy: null,
  updatedAt: null,
}

function toPublic(row: GeoRow): TenantGeoPolicy {
  let countries: string[] = []
  if (row.countries) {
    try {
      const parsed = typeof row.countries === "string" ? JSON.parse(row.countries) : row.countries
      countries = normalizeCountryList(parsed)
    } catch {
      countries = []
    }
  }
  return {
    tenantId: Number(row.tenant_id),
    enabled: row.enabled === 1,
    mode: row.mode,
    countries,
    unknownAction: row.unknown_action,
    emergencyAccess: row.emergency_access === 1,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}

/** Read the tenant's geo policy, or a disabled default when none is configured. */
export async function getGeoPolicy(tenantId: number | null): Promise<TenantGeoPolicy> {
  if (tenantId == null) return { tenantId: 0, ...DISABLED_DEFAULT }
  await ensureGeoPolicySchema()
  const rows = await query<GeoRow[]>(`SELECT * FROM \`tenant_geo_policies\` WHERE tenant_id = ? LIMIT 1`, [tenantId])
  if (rows.length === 0) return { tenantId, ...DISABLED_DEFAULT }
  return toPublic(rows[0])
}

export type GeoPolicyInput = {
  enabled?: unknown
  mode?: unknown
  countries?: unknown
  unknownAction?: unknown
  emergencyAccess?: unknown
}

/** Validate and normalize an inbound policy, throwing on bad shape. */
function validate(input: GeoPolicyInput): {
  enabled: boolean
  mode: "allow" | "block"
  countries: string[]
  unknownAction: "block" | "allow"
  emergencyAccess: boolean
} {
  const mode = input.mode === "block" ? "block" : input.mode === "allow" ? "allow" : "allow"
  const unknownAction = input.unknownAction === "allow" ? "allow" : "block"
  const countries = normalizeCountryList(input.countries)
  const enabled = Boolean(input.enabled)
  // Guard against locking a tenant out with an empty allow-list while enabled.
  if (enabled && mode === "allow" && countries.length === 0) {
    throw new Error("An enabled allow-list must include at least one country")
  }
  return { enabled, mode, countries, unknownAction, emergencyAccess: Boolean(input.emergencyAccess) }
}

/** Create or update the tenant's geo policy (idempotent upsert) and audit it. */
export async function upsertGeoPolicy(
  tenantId: number | null,
  actor: { userId: number; name?: string | null },
  input: GeoPolicyInput,
): Promise<TenantGeoPolicy> {
  if (tenantId == null) throw new Error("A tenant context is required to configure a geo policy")
  await ensureGeoPolicySchema()
  const v = validate(input)
  await query(
    `INSERT INTO \`tenant_geo_policies\`
       (tenant_id, enabled, mode, countries, unknown_action, emergency_access, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       mode = VALUES(mode),
       countries = VALUES(countries),
       unknown_action = VALUES(unknown_action),
       emergency_access = VALUES(emergency_access),
       updated_by = VALUES(updated_by)`,
    [
      tenantId,
      v.enabled ? 1 : 0,
      v.mode,
      JSON.stringify(v.countries),
      v.unknownAction,
      v.emergencyAccess ? 1 : 0,
      actor.userId,
    ],
  )
  await recordSecurityEvent({
    tenantId,
    category: "geo_policy",
    action: "policy_updated",
    outcome: "updated",
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    detail: {
      enabled: v.enabled,
      mode: v.mode,
      countries: v.countries,
      unknownAction: v.unknownAction,
      emergencyAccess: v.emergencyAccess,
    },
  })
  return getGeoPolicy(tenantId)
}

export type GeoEnforcementResult = {
  denied: boolean
  decision: GeoDecision
  /** True when a denial was overridden by an audited emergency bypass. */
  bypassed: boolean
}

/**
 * Enforce the tenant geo policy for a sign-in attempt against a TRUSTED country.
 * Fails safely for an unknown location per the tenant's `unknownAction`. A
 * denial can be overridden by an audited emergency bypass when the tenant has
 * enabled emergency access AND the caller is authorized (`emergencyAuthorized`).
 * Every block and every bypass is recorded in the security audit trail.
 */
export async function enforceGeoPolicy(
  tenantId: number | null,
  params: {
    country: string | null
    userId: number
    userName?: string | null
    userEmail?: string | null
    ip?: string | null
    emergencyAuthorized?: boolean
  },
): Promise<GeoEnforcementResult> {
  const policy = await getGeoPolicy(tenantId)
  const country = normalizeCountry(params.country)
  const decision = evaluateGeoPolicy(policy, country)

  if (!decision.denied) {
    return { denied: false, decision, bypassed: false }
  }

  // Audited emergency access: never let a misconfigured geo policy permanently
  // lock out the operator who must fix it.
  if (policy.emergencyAccess && params.emergencyAuthorized) {
    await recordSecurityEvent({
      tenantId,
      category: "emergency_bypass",
      action: "geo_policy_bypass",
      outcome: "bypassed",
      actorUserId: params.userId,
      actorName: params.userName ?? null,
      subjectEmail: params.userEmail ?? null,
      ipAddress: params.ip ?? null,
      detail: { reason: decision.reason, country: decision.country, unknownLocation: decision.unknownLocation },
    })
    return { denied: false, decision, bypassed: true }
  }

  await recordSecurityEvent({
    tenantId,
    category: "geo_policy",
    action: "sign_in_blocked",
    outcome: "blocked",
    actorUserId: params.userId,
    actorName: params.userName ?? null,
    subjectEmail: params.userEmail ?? null,
    ipAddress: params.ip ?? null,
    detail: {
      reason: decision.reason,
      country: decision.country,
      unknownLocation: decision.unknownLocation,
      mode: policy.mode,
    },
  })
  return { denied: true, decision, bypassed: false }
}
