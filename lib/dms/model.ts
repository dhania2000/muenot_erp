/**
 * SPEC 86 — Document Management System (pure model layer).
 * ---------------------------------------------------------------------------
 * Framework-free constants + logic for the DMS: status/approval vocabularies,
 * access-level ranking and effective-permission resolution, expiry checks and
 * share-token helpers. Everything here is deterministic and dependency-light so
 * it can be unit-tested without a database or a request context.
 */
import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * SPEC 87 — Document lifecycle. A document moves through this vocabulary as it
 * is drafted, submitted into a configurable approval workflow, decided and
 * finally published or archived. The legacy `active` status maps to
 * `published` (see normalizeStatus) so pre-SPEC-87 rows keep working.
 */
export const DOC_STATUSES = [
  "draft",
  "submitted",
  "review",
  "approved",
  "rejected",
  "published",
  "archived",
] as const
export type DocStatus = (typeof DOC_STATUSES)[number]

/** Legacy → current status names kept tolerant so old rows normalize cleanly. */
const STATUS_ALIASES: Record<string, DocStatus> = { active: "published" }

export const APPROVAL_STATUSES = ["none", "pending", "approved", "rejected"] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/**
 * SPEC 87 — the configurable approval workflows a document can be routed
 * through. Each maps to an approval-authority `moduleKey` so tenant admins
 * configure the rule/level/delegation chain per document type using the
 * existing Approval Authority engine (no bespoke workflow config needed).
 */
export const DOC_WORKFLOW_TYPES = [
  { key: "sop", label: "SOP", moduleKey: "dms.sop" },
  { key: "policy", label: "Policy", moduleKey: "dms.policy" },
  { key: "contract", label: "Contract", moduleKey: "dms.contract" },
  { key: "invoice_attachment", label: "Invoice Attachment", moduleKey: "dms.invoice_attachment" },
  { key: "hr_document", label: "HR Document", moduleKey: "dms.hr_document" },
  { key: "training_material", label: "Training Material", moduleKey: "dms.training_material" },
] as const
export type DocWorkflowType = (typeof DOC_WORKFLOW_TYPES)[number]["key"]

export function normalizeWorkflowType(value: unknown): DocWorkflowType | null {
  const v = String(value ?? "").toLowerCase()
  return DOC_WORKFLOW_TYPES.some((t) => t.key === v) ? (v as DocWorkflowType) : null
}

export function workflowModuleKey(type: DocWorkflowType): string {
  return DOC_WORKFLOW_TYPES.find((t) => t.key === type)?.moduleKey ?? "dms.document"
}

export function workflowLabel(type: DocWorkflowType | null | undefined): string {
  if (!type) return "Document"
  return DOC_WORKFLOW_TYPES.find((t) => t.key === type)?.label ?? "Document"
}

// ---------------------------------------------------------------------------
// Lifecycle state machine (SPEC 87)
// ---------------------------------------------------------------------------

/** Legal next statuses from each state. Deterministic + dependency-free. */
export const DOC_TRANSITIONS: Record<DocStatus, DocStatus[]> = {
  draft: ["submitted", "archived"],
  submitted: ["review", "approved", "rejected", "draft", "archived"],
  review: ["approved", "rejected", "draft", "archived"],
  approved: ["published", "archived", "draft"],
  rejected: ["draft", "submitted", "archived"],
  published: ["archived", "draft"],
  archived: ["draft"],
}

/** True when `to` is a permitted transition from `from`. */
export function canTransition(from: DocStatus, to: DocStatus): boolean {
  if (from === to) return true
  return DOC_TRANSITIONS[from]?.includes(to) ?? false
}

/** The statuses reachable in one step from `from`. */
export function allowedTransitions(from: DocStatus): DocStatus[] {
  return DOC_TRANSITIONS[from] ?? []
}

export type EngineStatus = "pending" | "approved" | "rejected" | "cancelled"

/**
 * Map an approval-authority request status onto the document lifecycle.
 * A pending request with no recorded decision yet is `submitted`; once any
 * approver has acted (multi-level chains in progress) it is `review`.
 */
export function mapApprovalToDocStatus(
  engineStatus: EngineStatus,
  opts: { anyStepActed?: boolean } = {},
): DocStatus {
  switch (engineStatus) {
    case "approved":
      return "approved"
    case "rejected":
      return "rejected"
    case "cancelled":
      return "draft"
    case "pending":
    default:
      return opts.anyStepActed ? "review" : "submitted"
  }
}

/** Permission levels a subject can hold on a document or folder, low → high. */
export const ACCESS_LEVELS = ["view", "download", "edit", "manage"] as const
export type AccessLevel = (typeof ACCESS_LEVELS)[number]

export const SUBJECT_TYPES = ["user", "role"] as const
export type SubjectType = (typeof SUBJECT_TYPES)[number]

/** What a public share link permits. */
export const SHARE_ACCESS = ["view", "download"] as const
export type ShareAccess = (typeof SHARE_ACCESS)[number]

/**
 * SPEC 89 — who a share link is issued to. Governs how access is gated:
 * - `link`     anyone holding the (unguessable) token
 * - `external` a named external party (email captured for audit); token-based
 * - `internal` a specific authenticated internal user (userId must match)
 * - `team`     an internal role/team (session role must match)
 */
export const SHARE_RECIPIENT_TYPES = ["link", "external", "internal", "team"] as const
export type ShareRecipientType = (typeof SHARE_RECIPIENT_TYPES)[number]

export function normalizeRecipientType(value: unknown): ShareRecipientType {
  const v = String(value ?? "").toLowerCase()
  return (SHARE_RECIPIENT_TYPES as readonly string[]).includes(v) ? (v as ShareRecipientType) : "link"
}

/** Human label for a recipient type. */
export function recipientTypeLabel(type: ShareRecipientType): string {
  switch (type) {
    case "internal":
      return "Internal user"
    case "team":
      return "Team / role"
    case "external":
      return "External party"
    case "link":
    default:
      return "Anyone with link"
  }
}

const ACCESS_RANK: Record<AccessLevel, number> = { view: 1, download: 2, edit: 3, manage: 4 }

// ---------------------------------------------------------------------------
// Normalizers (defensive — never trust client input)
// ---------------------------------------------------------------------------

export function normalizeStatus(value: unknown): DocStatus {
  const v = String(value ?? "").toLowerCase()
  return (DOC_STATUSES as readonly string[]).includes(v) ? (v as DocStatus) : "draft"
}

export function normalizeApproval(value: unknown): ApprovalStatus {
  const v = String(value ?? "").toLowerCase()
  return (APPROVAL_STATUSES as readonly string[]).includes(v) ? (v as ApprovalStatus) : "none"
}

export function normalizeAccessLevel(value: unknown): AccessLevel {
  const v = String(value ?? "").toLowerCase()
  return (ACCESS_LEVELS as readonly string[]).includes(v) ? (v as AccessLevel) : "view"
}

export function normalizeSubjectType(value: unknown): SubjectType {
  const v = String(value ?? "").toLowerCase()
  return v === "role" ? "role" : "user"
}

export function normalizeShareAccess(value: unknown): ShareAccess {
  const v = String(value ?? "").toLowerCase()
  return v === "download" ? "download" : "view"
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** Stable, human-readable document reference (DOC-000042). */
export function formatDocRef(id: number): string {
  return `DOC-${String(id).padStart(6, "0")}`
}

// ---------------------------------------------------------------------------
// Access resolution
// ---------------------------------------------------------------------------

export type AccessGrant = {
  subjectType: SubjectType
  subjectId: string
  accessLevel: AccessLevel
}

export type AccessContext = {
  userId: number
  role: string
  /** Platform/tenant admins get full control regardless of explicit grants. */
  isAdmin: boolean
  /** True when the acting user owns (or created) the document. */
  isOwner: boolean
  /** Explicit grants attached to the document (and inherited from its folder). */
  grants: AccessGrant[]
}

/**
 * Resolve the highest access level the acting user effectively holds.
 *
 * - Owners and admins always get `manage`.
 * - Otherwise take the strongest of every grant whose subject matches the user
 *   (`user:<id>`) or one of their roles (`role:<role>`).
 * - No matching grant → `null` (no access).
 */
export function resolveEffectiveAccess(ctx: AccessContext): AccessLevel | null {
  if (ctx.isAdmin || ctx.isOwner) return "manage"
  let best: AccessLevel | null = null
  for (const grant of ctx.grants) {
    const matches =
      (grant.subjectType === "user" && String(grant.subjectId) === String(ctx.userId)) ||
      (grant.subjectType === "role" && String(grant.subjectId).toLowerCase() === String(ctx.role).toLowerCase())
    if (!matches) continue
    if (best == null || ACCESS_RANK[grant.accessLevel] > ACCESS_RANK[best]) {
      best = grant.accessLevel
    }
  }
  return best
}

/**
 * Folder id + all ancestor ids, resolved from an in-memory parent map. Used to
 * batch-inherit folder permissions without a query per ancestor level.
 */
export function ancestorIdsFromMap(
  folderId: number | null,
  parents: Map<number, number | null>,
): number[] {
  if (folderId == null) return []
  const ids: number[] = []
  const seen = new Set<number>()
  let current: number | null = folderId
  while (current != null && !seen.has(current)) {
    seen.add(current)
    ids.push(current)
    current = parents.get(current) ?? null
  }
  return ids
}

/** True when `held` is at least as strong as `required`. */
export function accessAtLeast(held: AccessLevel | null, required: AccessLevel): boolean {
  if (!held) return false
  return ACCESS_RANK[held] >= ACCESS_RANK[required]
}

export type DmsAction = "view" | "download" | "edit" | "delete" | "share" | "manage_permissions" | "approve"

const ACTION_REQUIREMENT: Record<DmsAction, AccessLevel> = {
  view: "view",
  download: "download",
  edit: "edit",
  delete: "manage",
  share: "edit",
  manage_permissions: "manage",
  approve: "manage",
}

/** Whether the resolved access level is sufficient to perform `action`. */
export function canPerform(action: DmsAction, held: AccessLevel | null): boolean {
  return accessAtLeast(held, ACTION_REQUIREMENT[action])
}

// ---------------------------------------------------------------------------
// Expiry / retention
// ---------------------------------------------------------------------------

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** True when the document's expiry date has passed. */
export function isExpired(expiresAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  const d = toDate(expiresAt)
  return d != null && d.getTime() <= now.getTime()
}

// ---------------------------------------------------------------------------
// Share tokens
// ---------------------------------------------------------------------------

/** Generate a URL-safe, unguessable share token. */
export function generateShareToken(): string {
  return randomBytes(24).toString("base64url")
}

export type ShareLike = {
  expiresAt: string | Date | null
  revokedAt: string | Date | null
}

/** A share link is usable only when it is not revoked and not expired. */
export function shareTokenValid(share: ShareLike, now: Date = new Date()): boolean {
  if (toDate(share.revokedAt) != null) return false
  const exp = toDate(share.expiresAt)
  if (exp != null && exp.getTime() <= now.getTime()) return false
  return true
}

// ---------------------------------------------------------------------------
// SPEC 89 — signed access decision (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Everything the access gate needs to know about a share. Deliberately free of
 * the password *hash* — the caller verifies the password separately (bcrypt)
 * and passes the boolean result in as `passwordVerified`, so this stays a pure,
 * synchronous, side-effect-free function that unit tests can exercise directly.
 */
export type ShareGate = {
  access: ShareAccess
  expiresAt: string | Date | null
  revokedAt: string | Date | null
  recipientType: ShareRecipientType
  /** userId (internal), role (team) or email (external); null for `link`. */
  recipient: string | null
  hasPassword: boolean
  maxDownloads: number | null
  downloadCount: number
}

/** The authenticated viewer, when one exists (needed for internal/team gates). */
export type ShareViewer = {
  userId: number
  role: string
} | null

export type ShareIntent = "view" | "download"

export type ShareDenialReason =
  | "revoked"
  | "expired"
  | "login_required"
  | "forbidden"
  | "password_required"
  | "download_disabled"
  | "download_limit"

export type ShareDecision = { ok: true } | { ok: false; reason: ShareDenialReason }

/**
 * Decide whether a share access attempt is permitted. Checks run in order of
 * severity so the caller always learns the *first* blocking reason:
 *   revoked → expired → recipient scope → password → download policy.
 */
export function evaluateShareAccess(input: {
  share: ShareGate
  intent: ShareIntent
  viewer?: ShareViewer
  passwordVerified?: boolean
  now?: Date
}): ShareDecision {
  const { share, intent } = input
  const viewer = input.viewer ?? null
  const now = input.now ?? new Date()

  if (toDate(share.revokedAt) != null) return { ok: false, reason: "revoked" }

  const exp = toDate(share.expiresAt)
  if (exp != null && exp.getTime() <= now.getTime()) return { ok: false, reason: "expired" }

  // Recipient scoping — internal/team require a matching signed-in viewer.
  if (share.recipientType === "internal") {
    if (!viewer) return { ok: false, reason: "login_required" }
    if (String(viewer.userId) !== String(share.recipient ?? "")) return { ok: false, reason: "forbidden" }
  } else if (share.recipientType === "team") {
    if (!viewer) return { ok: false, reason: "login_required" }
    if (String(viewer.role).toLowerCase() !== String(share.recipient ?? "").toLowerCase()) {
      return { ok: false, reason: "forbidden" }
    }
  }

  // Password protection applies to every recipient type when configured.
  if (share.hasPassword && !input.passwordVerified) return { ok: false, reason: "password_required" }

  // Download policy: view-only links never yield the file as an attachment, and
  // a per-link download cap stops further downloads once reached.
  if (intent === "download") {
    if (share.access !== "download") return { ok: false, reason: "download_disabled" }
    if (share.maxDownloads != null && share.downloadCount >= share.maxDownloads) {
      return { ok: false, reason: "download_limit" }
    }
  }

  return { ok: true }
}

/** True when the share has exhausted its download allowance. */
export function shareDownloadExhausted(share: Pick<ShareGate, "maxDownloads" | "downloadCount">): boolean {
  return share.maxDownloads != null && share.downloadCount >= share.maxDownloads
}

/** User-facing message for a denial reason. */
export function shareDenialMessage(reason: ShareDenialReason): string {
  switch (reason) {
    case "revoked":
      return "This link has been revoked."
    case "expired":
      return "This link has expired."
    case "login_required":
      return "Please sign in with your organization account to open this document."
    case "forbidden":
      return "This link is restricted to a specific recipient."
    case "password_required":
      return "This link is password protected."
    case "download_disabled":
      return "This link is view-only. Downloading is not permitted."
    case "download_limit":
      return "The download limit for this link has been reached."
    default:
      return "This link is not available."
  }
}
