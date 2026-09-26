/**
 * SPEC 40 — Master data & configuration inheritance: tenant policy definitions.
 * ---------------------------------------------------------------------------
 * Pure, dependency-free catalogue (no DB, no `server-only`) of the tenant
 * policies whose values inherit down the org hierarchy
 * (global → company → branch → department → user). Each field declares:
 *
 *   - the domain it belongs to (expense / leave / storage / security),
 *   - its type + default (the last-resort floor of the precedence chain),
 *   - which scope levels are ALLOWED to override it (`overridableLevels`) so a
 *     control-bearing security policy cannot be silently loosened by a single
 *     user, and
 *   - whether the change is `governed` (a critical master change that must be
 *     made by an authorised actor and audited — SPEC 40 governance).
 *
 * Keeping this pure means the precedence + override-legality rules built on top
 * (lib/setting-inheritance/model.ts) are unit-tested without a database.
 */

import { SCOPE_LEVELS, type ScopeLevel } from "./model"

export const POLICY_DOMAINS = ["expense", "leave", "storage", "security"] as const
export type PolicyDomain = (typeof POLICY_DOMAINS)[number]

export const POLICY_DOMAIN_LABELS: Record<PolicyDomain, string> = {
  expense: "Expense policy",
  leave: "Leave policy",
  storage: "Storage policy",
  security: "Security policy",
}

export type PolicyFieldType = "number" | "toggle" | "select" | "text"

export type PolicyField = {
  /** Fully-qualified, stable key used as the cross-module reference, e.g. "expense.max_claim_amount". */
  key: string
  domain: PolicyDomain
  label: string
  description: string
  type: PolicyFieldType
  /** Last-resort default (the floor of the precedence chain). */
  default: string
  options?: string[]
  /** A secret VALUE is never serialized in the clear off the server. */
  secret?: boolean
  /**
   * Scope levels permitted to hold an override for this field. A field omitted
   * from a level is inherited from the nearest broader level that set it. This
   * is how a control policy is pinned to company/global and cannot be relaxed
   * per-department or per-user.
   */
  overridableLevels: ScopeLevel[]
  /**
   * Critical master change: writing an override must be performed by an
   * authorised actor (segregation of duties) and is always audited.
   */
  governed?: boolean
}

const ALL_LEVELS: ScopeLevel[] = [...SCOPE_LEVELS]
const COMPANY_AND_UP: ScopeLevel[] = ["global", "company"]
const DOWN_TO_DEPARTMENT: ScopeLevel[] = ["global", "company", "branch", "department"]

export const POLICY_FIELDS: PolicyField[] = [
  // --- Expense --------------------------------------------------------------
  {
    key: "expense.max_claim_amount",
    domain: "expense",
    label: "Maximum single claim",
    description: "Largest amount a single expense claim may request before it is blocked.",
    type: "number",
    default: "50000",
    overridableLevels: DOWN_TO_DEPARTMENT,
    governed: true,
  },
  {
    key: "expense.receipt_required_above",
    domain: "expense",
    label: "Receipt required above",
    description: "Claims above this amount must attach a receipt.",
    type: "number",
    default: "1000",
    overridableLevels: DOWN_TO_DEPARTMENT,
  },
  {
    key: "expense.auto_approve_below",
    domain: "expense",
    label: "Auto-approve below",
    description: "Claims below this amount skip manual approval.",
    type: "number",
    default: "500",
    overridableLevels: DOWN_TO_DEPARTMENT,
  },
  {
    key: "expense.approval_required",
    domain: "expense",
    label: "Approval required",
    description: "Whether expense claims require an approver.",
    type: "toggle",
    default: "true",
    overridableLevels: DOWN_TO_DEPARTMENT,
    governed: true,
  },

  // --- Leave ----------------------------------------------------------------
  {
    key: "leave.annual_allowance_days",
    domain: "leave",
    label: "Annual leave allowance (days)",
    description: "Paid annual leave days granted per year.",
    type: "number",
    default: "24",
    overridableLevels: DOWN_TO_DEPARTMENT,
  },
  {
    key: "leave.carry_forward_max",
    domain: "leave",
    label: "Carry-forward maximum (days)",
    description: "Maximum unused leave days that carry into the next year.",
    type: "number",
    default: "10",
    overridableLevels: DOWN_TO_DEPARTMENT,
  },
  {
    key: "leave.min_notice_days",
    domain: "leave",
    label: "Minimum notice (days)",
    description: "Advance notice required before a leave start date.",
    type: "number",
    default: "3",
    overridableLevels: ALL_LEVELS,
  },
  {
    key: "leave.approval_required",
    domain: "leave",
    label: "Approval required",
    description: "Whether leave requests require an approver.",
    type: "toggle",
    default: "true",
    overridableLevels: DOWN_TO_DEPARTMENT,
    governed: true,
  },

  // --- Storage --------------------------------------------------------------
  {
    key: "storage.max_upload_mb",
    domain: "storage",
    label: "Maximum upload size (MB)",
    description: "Largest single file a user may upload.",
    type: "number",
    default: "25",
    overridableLevels: DOWN_TO_DEPARTMENT,
  },
  {
    key: "storage.user_quota_mb",
    domain: "storage",
    label: "Per-user storage quota (MB)",
    description: "Total storage a single user may consume.",
    type: "number",
    default: "1024",
    overridableLevels: ALL_LEVELS,
  },
  {
    key: "storage.retention_days",
    domain: "storage",
    label: "Retention period (days)",
    description: "How long uploaded documents are retained before eligible for cleanup.",
    type: "number",
    default: "365",
    overridableLevels: COMPANY_AND_UP,
    governed: true,
  },
  {
    key: "storage.allowed_file_types",
    domain: "storage",
    label: "Allowed file types",
    description: "Comma-separated file extensions accepted for upload.",
    type: "text",
    default: "pdf,png,jpg,jpeg,docx,xlsx,csv",
    overridableLevels: DOWN_TO_DEPARTMENT,
  },

  // --- Security -------------------------------------------------------------
  {
    key: "security.password_min_length",
    domain: "security",
    label: "Minimum password length",
    description: "Fewest characters allowed in a user password.",
    type: "number",
    default: "8",
    overridableLevels: COMPANY_AND_UP,
    governed: true,
  },
  {
    key: "security.mfa_required",
    domain: "security",
    label: "Require MFA",
    description: "Force multi-factor authentication for sign-in.",
    type: "toggle",
    default: "false",
    overridableLevels: COMPANY_AND_UP,
    governed: true,
  },
  {
    key: "security.session_timeout_min",
    domain: "security",
    label: "Session timeout (minutes)",
    description: "Idle minutes before a session is ended.",
    type: "number",
    default: "480",
    overridableLevels: COMPANY_AND_UP,
    governed: true,
  },
  {
    key: "security.max_login_attempts",
    domain: "security",
    label: "Maximum login attempts",
    description: "Failed sign-ins before an account is locked.",
    type: "number",
    default: "5",
    overridableLevels: COMPANY_AND_UP,
    governed: true,
  },
  {
    key: "security.ip_allowlist",
    domain: "security",
    label: "IP allow-list",
    description: "Comma-separated CIDR ranges permitted to sign in. Empty allows all.",
    type: "text",
    default: "",
    secret: true,
    overridableLevels: COMPANY_AND_UP,
    governed: true,
  },
]

const BY_KEY = new Map(POLICY_FIELDS.map((f) => [f.key, f]))
const BY_DOMAIN = new Map<PolicyDomain, PolicyField[]>()
for (const f of POLICY_FIELDS) {
  const list = BY_DOMAIN.get(f.domain) ?? []
  list.push(f)
  BY_DOMAIN.set(f.domain, list)
}

export function isPolicyDomain(v: unknown): v is PolicyDomain {
  return typeof v === "string" && (POLICY_DOMAINS as readonly string[]).includes(v)
}

export function getPolicyField(key: string): PolicyField | undefined {
  return BY_KEY.get(key)
}

export function policyFieldsForDomain(domain: PolicyDomain): PolicyField[] {
  return BY_DOMAIN.get(domain) ?? []
}
