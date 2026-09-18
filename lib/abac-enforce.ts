import "server-only"
import { getCurrentTenant } from "./tenant-context"
import { abacBlocks, type AbacAction, type AttributeBag, type AbacEvaluationResult } from "./abac-model"
import { getAbacSettings, listEnabledPolicies, resolveSubjectAttributes } from "./abac-store"
import type { SessionPayload } from "./auth"

/**
 * SPEC 9 — the bridge between the pure ABAC engine and a live request.
 * ---------------------------------------------------------------------------
 * ABAC is an ADDITIVE RESTRICTION layer on top of RBAC: RBAC decides whether a
 * role may perform an action on a module; ABAC can then further DENY a specific
 * access based on the attributes of the user, the record and the environment.
 *
 * Design guarantees that keep this non-breaking:
 *   - With no enabled policies for the tenant, `abacDenies` always returns
 *     false, so RBAC-only behaviour is unchanged for every existing tenant.
 *   - A missing tenant (system / pre-auth path) short-circuits to "not denied".
 *   - Resolution failures never throw into the caller; they resolve to "not
 *     denied" so an attribute-lookup problem can never lock everyone out.
 */

/**
 * Map the columns present on a loaded record onto ABAC resource attributes.
 * Mirrors the subject resolver's candidate approach so the same policy works
 * across the ERP's differing table shapes. Only attributes actually present on
 * the row are populated; everything else stays undefined (fail-safe).
 */
const RESOURCE_COLUMN_CANDIDATES: Record<string, string[]> = {
  department: ["department", "department_name", "dept", "department_id"],
  branch: ["branch", "branch_name", "branch_id"],
  entity: ["entity", "legal_entity", "entity_id", "legal_entity_id"],
  location: ["location", "work_location", "office_location", "location_id"],
  employee_level: ["employee_level", "level", "grade", "band"],
  data_classification: ["data_classification", "classification", "sensitivity"],
  amount: ["amount", "total", "total_amount", "grand_total", "value", "net_amount"],
  project: ["project", "project_name", "project_id"],
  cost_center: ["cost_center", "cost_centre", "cost_center_id"],
  geography: ["geography", "region", "country", "territory"],
}

export function resourceAttributesFromRow(row: Record<string, any>): AttributeBag {
  const bag: AttributeBag = {}
  if (!row || typeof row !== "object") return bag
  for (const [attr, candidates] of Object.entries(RESOURCE_COLUMN_CANDIDATES)) {
    for (const col of candidates) {
      if (col in row) {
        const v = row[col]
        if (v !== null && v !== undefined && v !== "") {
          bag[attr] = attr === "amount" ? Number(v) : v
          break
        }
      }
    }
  }
  // Expose common owner columns so hierarchy policies (resource.owner_id IN
  // subject.manager_chain) work without per-module wiring.
  for (const ownerCol of ["owner_id", "assigned_to", "created_by", "added_by", "user_id", "employee_id"]) {
    if (ownerCol in row && row[ownerCol] != null) {
      bag.owner_id = Number(row[ownerCol])
      break
    }
  }
  return bag
}

/** Normalize a CRUD/extended action verb onto the ABAC action vocabulary. */
const ACTION_ALIASES: Record<string, AbacAction> = {
  add: "create",
  create: "create",
  view: "view",
  read: "view",
  update: "edit",
  edit: "edit",
  delete: "delete",
  approve: "approve",
  reject: "reject",
  export: "export",
  export_report: "export",
  export_return: "export",
  import: "import",
  import_export: "import",
  download: "download",
  download_screenshot: "download",
  email: "email",
  email_report: "email",
  manage_settings: "configuration",
  manage_filing: "configuration",
  configuration: "configuration",
  admin: "admin",
}

export function normalizeAbacAction(action: string): string {
  return ACTION_ALIASES[action] ?? action
}

/**
 * Whether ABAC DENIES this access. `resource` is the already-loaded record (its
 * columns become resource attributes). Returns { denied, result } so callers
 * can surface the reason; `denied` is false whenever ABAC does not block.
 */
export async function evaluateAbac(
  session: SessionPayload,
  module: string,
  action: string,
  resource: Record<string, any> = {},
  environment?: AttributeBag,
): Promise<{ denied: boolean; result: AbacEvaluationResult | null }> {
  try {
    const tenant = getCurrentTenant()
    if (!tenant) return { denied: false, result: null }

    const policies = await listEnabledPolicies(tenant.tenantId)
    if (policies.length === 0) return { denied: false, result: null }

    const [subject, settings] = await Promise.all([
      resolveSubjectAttributes(session.userId),
      getAbacSettings(tenant.tenantId),
    ])

    const { blocked, result } = abacBlocks(
      policies,
      { module, action: normalizeAbacAction(action) },
      { subject, resource: resourceAttributesFromRow(resource), environment },
      settings.algorithm,
    )
    // A `not_applicable` result honours the tenant's default posture: a
    // default-deny tenant blocks access that no policy explicitly permits.
    const denied =
      blocked || (result.decision === "not_applicable" && settings.defaultDecision === "deny")
    return { denied, result }
  } catch (err) {
    console.error("[v0] ABAC evaluation failed:", err)
    return { denied: false, result: null }
  }
}

/** Boolean convenience for the RBAC enforcement chokepoints. */
export async function abacDenies(
  session: SessionPayload,
  module: string,
  action: string,
  resource: Record<string, any> = {},
): Promise<boolean> {
  const { denied } = await evaluateAbac(session, module, action, resource)
  return denied
}
