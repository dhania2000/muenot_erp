// ---------------------------------------------------------------------------
// Legal E-sign — client-safe shared config, catalogs and types.
//
// NO server-only imports so the dashboard, request wizard, field-placement
// editor and signing page can import it in the browser. Every server module
// re-exports the pieces it needs from here. Mirrors lib/legal-contracts-shared.
// ---------------------------------------------------------------------------

// --- Request lifecycle ------------------------------------------------------
export const ESIGN_STATUSES = [
  "Draft",
  "Sent",
  "Viewed",
  "Partially Signed",
  "Awaiting Signature",
  "Completed",
  "Rejected",
  "Expired",
  "Cancelled",
] as const
export type EsignStatus = (typeof ESIGN_STATUSES)[number]

// --- Per-signer lifecycle ---------------------------------------------------
export const SIGNER_STATUSES = ["Pending", "Sent", "Viewed", "Signed", "Rejected"] as const
export type SignerStatus = (typeof SIGNER_STATUSES)[number]

// --- Signer types -----------------------------------------------------------
export const SIGNER_TYPES = [
  "authorized_signatory",
  "employee",
  "client",
  "vendor",
  "external",
] as const
export type SignerType = (typeof SIGNER_TYPES)[number]

export const SIGNER_TYPE_META: Record<SignerType, { label: string; internal: boolean; module: string }> = {
  authorized_signatory: { label: "Muenot Authorized Signatory", internal: true, module: "E-sign Settings" },
  employee: { label: "Muenot Employee", internal: true, module: "HR" },
  client: { label: "Client", internal: false, module: "Sales / Clients" },
  vendor: { label: "Vendor", internal: false, module: "Finance" },
  external: { label: "Other External Recipient", internal: false, module: "Manual" },
}

export function signerTypeLabel(t: string | null | undefined): string {
  return SIGNER_TYPE_META[(t as SignerType)]?.label ?? "Signer"
}

/** Internal signers use a saved authorized signature; external signers draw/upload. */
export function isInternalSignerType(t: string | null | undefined): boolean {
  return !!SIGNER_TYPE_META[(t as SignerType)]?.internal
}

// --- Signing modes ----------------------------------------------------------
export const SIGNING_TYPES = ["sequential", "parallel"] as const
export type SigningType = (typeof SIGNING_TYPES)[number]

// --- Document sources (which module launched the request) -------------------
export const ESIGN_SOURCES = [
  "contract",
  "hr",
  "recruit",
  "sales",
  "vendor",
  "operations",
  "manual",
] as const
export type EsignSource = (typeof ESIGN_SOURCES)[number]

export const ESIGN_SOURCE_META: Record<EsignSource, { label: string }> = {
  contract: { label: "Legal Contract" },
  hr: { label: "HR" },
  recruit: { label: "Recruitment" },
  sales: { label: "Sales" },
  vendor: { label: "Finance / Vendor" },
  operations: { label: "Operations" },
  manual: { label: "Manual" },
}

export function esignSourceLabel(s: string | null | undefined): string {
  return ESIGN_SOURCE_META[(s as EsignSource)]?.label ?? "Document"
}

// --- Signature field types --------------------------------------------------
export const FIELD_TYPES = ["signature", "date", "name", "designation", "text"] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const FIELD_TYPE_META: Record<FieldType, { label: string; needsSignature: boolean }> = {
  signature: { label: "Signature", needsSignature: true },
  date: { label: "Date", needsSignature: false },
  name: { label: "Name", needsSignature: false },
  designation: { label: "Designation", needsSignature: false },
  text: { label: "Text", needsSignature: false },
}

// --- Signatory lifecycle ----------------------------------------------------
export const SIGNATORY_STATUSES = ["Active", "Inactive", "Revoked"] as const
export type SignatoryStatus = (typeof SIGNATORY_STATUSES)[number]

// --- Signature methods ------------------------------------------------------
export const SIGNATURE_METHODS = ["saved", "draw", "upload"] as const
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number]

// --- File validation --------------------------------------------------------
export const SIGNATURE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg"]
export const SIGNATURE_MAX_BYTES = 3 * 1024 * 1024 // 3 MB

// --- Display tones ----------------------------------------------------------
export function esignStatusTone(status: string): "green" | "blue" | "amber" | "slate" | "red" {
  switch (status) {
    case "Completed":
      return "green"
    case "Sent":
    case "Viewed":
    case "Awaiting Signature":
      return "blue"
    case "Partially Signed":
    case "Draft":
      return "amber"
    case "Rejected":
    case "Expired":
    case "Cancelled":
      return "red"
    default:
      return "slate"
  }
}

export function signerStatusTone(status: string): "green" | "blue" | "amber" | "slate" | "red" {
  switch (status) {
    case "Signed":
      return "green"
    case "Sent":
    case "Viewed":
      return "blue"
    case "Pending":
      return "amber"
    case "Rejected":
      return "red"
    default:
      return "slate"
  }
}

// --- Terminal states --------------------------------------------------------
export const ESIGN_TERMINAL_STATUSES: EsignStatus[] = ["Completed", "Rejected", "Cancelled", "Expired"]
export function isTerminalStatus(s: string | null | undefined): boolean {
  return ESIGN_TERMINAL_STATUSES.includes(s as EsignStatus)
}

// --- Row types (shared between server and client) ---------------------------
export type EsignSigner = {
  id: number
  request_id: number
  signer_uid: string
  signer_type: SignerType
  ref_id: string | null
  signatory_id: number | null
  name: string
  email: string
  mobile: string | null
  role: string | null
  signing_order: number
  status: SignerStatus
  token_expires_at: string | null
  token_used: number
  signature_method: SignatureMethod | null
  signature_file_id: string | null
  viewed_at: string | null
  signed_at: string | null
  rejected_at: string | null
  reject_reason: string | null
  confirmed: number
  created_at: string | null
  // joined
  fields?: EsignField[]
}

export type EsignField = {
  id: number
  request_id: number
  signer_id: number
  field_type: FieldType
  page: number
  pos_x: number
  pos_y: number
  width: number
  height: number
  value: string | null
}

export type EsignRequest = {
  id: number
  request_uid: string
  title: string
  document_source: EsignSource
  contract_id: number | null
  template_id: number | null
  template_version: number | null
  source_module: string | null
  source_record_id: string | null
  signing_type: SigningType
  status: EsignStatus
  due_date: string | null
  message: string | null
  auto_email_signed: number
  require_confirm: number
  base_file_id: string | null
  signed_file_id: string | null
  cancel_reason: string | null
  created_by: number | null
  created_at: string | null
  updated_at: string | null
  sent_at: string | null
  completed_at: string | null
  // joined
  created_by_name?: string | null
  contract_reference?: string | null
  signers?: EsignSigner[]
}

export type EsignSignatory = {
  id: number
  signatory_uid: string
  employee_id: number | null
  name: string
  designation: string | null
  department: string | null
  email: string | null
  signature_file_id: string | null
  signature_status: "None" | "Uploaded"
  status: SignatoryStatus
  is_default: number
  default_scope: string | null
  created_by: number | null
  created_at: string | null
  updated_at: string | null
  // joined
  employee_name?: string | null
}

export type EsignEvent = {
  id: number
  request_id: number
  signer_id: number | null
  event_type: string
  summary: string
  detail: Record<string, unknown> | null
  actor_id: number | null
  actor_name: string | null
  created_at: string | null
}

export type EsignStats = {
  total: number
  awaiting: number
  completed: number
  partiallySigned: number
  rejected: number
  expired: number
  cancelled: number
  draft: number
}
