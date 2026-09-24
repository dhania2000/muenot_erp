/**
 * Data-region catalog + residency rules (pure, DB-free, Node-free).
 * ---------------------------------------------------------------------------
 * Region routing has two independent concerns this module owns as pure logic so
 * it can be unit-tested and (type-only) shared with the UI:
 *
 *   1. RESIDENCY  — a tenant anchors its data to ONE residency zone (its
 *      `data_region`). Its database, object storage and backups must all stay
 *      within the SAME residency group. Placing any of them in a foreign group
 *      is a residency violation (e.g. EU-resident data may never be stored or
 *      backed up in a US region).
 *
 *   2. DRIFT      — the region a live connection actually resolves to must match
 *      the region the tenant is CONFIGURED for. A mismatch (a stale cached pool,
 *      a moved secret, a mis-typed DSN host) is "region drift" and must fail
 *      closed rather than silently serve a tenant from the wrong region.
 *
 * This module carries no `server-only`, no `node:*` and no DB import.
 */

// ---------------------------------------------------------------------------
// Residency groups + physical regions
// ---------------------------------------------------------------------------

/** A residency zone. Data may move freely WITHIN a group, never ACROSS groups. */
export const RESIDENCY_GROUPS = ["us", "eu", "apac", "mea"] as const
export type ResidencyGroup = (typeof RESIDENCY_GROUPS)[number]

export const RESIDENCY_GROUP_LABELS: Record<ResidencyGroup, string> = {
  us: "United States",
  eu: "European Union",
  apac: "Asia Pacific",
  mea: "Middle East & Africa",
}

export type RegionDefinition = {
  id: string
  label: string
  group: ResidencyGroup
}

/**
 * The catalog of physical regions the platform can place a tenant's database,
 * storage and backups in. Each region belongs to exactly one residency group.
 * A tenant's `data_region` is one of these ids and fixes its residency group.
 */
export const DATA_REGIONS: readonly RegionDefinition[] = [
  { id: "us-east-1", label: "US East (N. Virginia)", group: "us" },
  { id: "us-west-2", label: "US West (Oregon)", group: "us" },
  { id: "eu-west-1", label: "EU West (Ireland)", group: "eu" },
  { id: "eu-central-1", label: "EU Central (Frankfurt)", group: "eu" },
  { id: "ap-south-1", label: "Asia Pacific (Mumbai)", group: "apac" },
  { id: "ap-southeast-1", label: "Asia Pacific (Singapore)", group: "apac" },
  { id: "me-central-1", label: "Middle East (UAE)", group: "mea" },
]

const REGION_MAP = new Map<string, RegionDefinition>(DATA_REGIONS.map((r) => [r.id, r]))

export function isDataRegion(value: unknown): value is string {
  return typeof value === "string" && REGION_MAP.has(value)
}

export function toDataRegion(value: unknown): string | null {
  return isDataRegion(value) ? value : null
}

export function getRegionDefinition(id: string | null | undefined): RegionDefinition | null {
  if (!id) return null
  return REGION_MAP.get(id) ?? null
}

export function residencyGroupOf(id: string | null | undefined): ResidencyGroup | null {
  return getRegionDefinition(id)?.group ?? null
}

export function regionsInGroup(group: ResidencyGroup): RegionDefinition[] {
  return DATA_REGIONS.filter((r) => r.group === group)
}

/** Every physical region a tenant anchored to `dataRegion` may legally use. */
export function allowedRegionsFor(dataRegion: string | null | undefined): RegionDefinition[] {
  const group = residencyGroupOf(dataRegion)
  return group ? regionsInGroup(group) : []
}

/**
 * Whether `target` is a legal placement for a tenant anchored to `dataRegion`.
 * Both must be known regions and share a residency group.
 */
export function regionsCompatible(dataRegion: string | null | undefined, target: string | null | undefined): boolean {
  const a = residencyGroupOf(dataRegion)
  const b = residencyGroupOf(target)
  return a != null && b != null && a === b
}

// ---------------------------------------------------------------------------
// Residency validation
// ---------------------------------------------------------------------------

export type RegionPlacement = {
  dbRegion?: string | null
  storageRegion?: string | null
  backupRegion?: string | null
}

export type RegionViolation = {
  facet: "data_region" | "db_region" | "storage_region" | "backup_region"
  message: string
}

/**
 * Validate a full region placement against a tenant's residency anchor. Returns
 * every violation found (empty array = compliant). A missing facet is NOT a
 * violation here — that is an availability decision the caller makes; this only
 * asserts that whatever IS set stays inside the residency group.
 */
export function validateRegionPlacement(
  dataRegion: string | null | undefined,
  placement: RegionPlacement,
): RegionViolation[] {
  const violations: RegionViolation[] = []

  if (!isDataRegion(dataRegion)) {
    violations.push({ facet: "data_region", message: "A valid data residency region is required." })
    // Without a valid anchor we cannot evaluate the rest.
    return violations
  }

  const group = residencyGroupOf(dataRegion)!
  const groupLabel = RESIDENCY_GROUP_LABELS[group]

  const check = (facet: RegionViolation["facet"], value: string | null | undefined, label: string) => {
    if (value == null || value === "") return
    if (!isDataRegion(value)) {
      violations.push({ facet, message: `${label} is not a known region.` })
      return
    }
    if (!regionsCompatible(dataRegion, value)) {
      violations.push({
        facet,
        message: `${label} (${value}) is outside the ${groupLabel} residency zone and violates data residency.`,
      })
    }
  }

  check("db_region", placement.dbRegion, "Database region")
  check("storage_region", placement.storageRegion, "Storage region")
  check("backup_region", placement.backupRegion, "Backup region")

  return violations
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

export type RegionDriftResult = {
  drifted: boolean
  expected: string | null
  actual: string | null
  message: string | null
}

/**
 * Detect drift between the region a tenant is CONFIGURED for (`expected`) and
 * the region a live connection actually RESOLVED to (`actual`). Any mismatch
 * (including an unknown/absent actual region) is drift — the caller must refuse
 * to serve the request rather than read/write in the wrong region.
 */
export function detectRegionDrift(
  expected: string | null | undefined,
  actual: string | null | undefined,
): RegionDriftResult {
  const exp = expected ?? null
  const act = actual ?? null
  if (exp && act && exp === act) {
    return { drifted: false, expected: exp, actual: act, message: null }
  }
  return {
    drifted: true,
    expected: exp,
    actual: act,
    message: `Region drift: connection resolved to "${act ?? "unknown"}" but tenant is configured for "${exp ?? "unknown"}".`,
  }
}
