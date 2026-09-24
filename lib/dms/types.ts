/**
 * SPEC 86 — Document Management System shared types.
 * Client-safe projections returned by the store + API layers.
 */
import type {
  AccessLevel,
  ApprovalStatus,
  DocStatus,
  DocWorkflowType,
  ShareAccess,
  ShareRecipientType,
  SubjectType,
} from "./model"

export type DmsFolder = {
  id: number
  name: string
  parentId: number | null
  ownerId: number | null
  createdBy: number | null
  createdAt: string | null
  updatedAt: string | null
  documentCount?: number
}

export type DmsCategory = {
  id: number
  name: string
  color: string | null
  description: string | null
  documentCount?: number
}

export type DmsTag = {
  id: number
  name: string
  documentCount?: number
}

export type DmsDocument = {
  id: number
  docRef: string
  title: string
  description: string | null
  folderId: number | null
  categoryId: number | null
  ownerId: number | null
  fileId: number | null
  /** Originating module when the document was created from HR/Finance/CRM/etc. */
  sourceModule: string | null
  sourceEntityType: string | null
  sourceEntityId: string | null
  status: DocStatus
  approvalStatus: ApprovalStatus
  /** SPEC 87 — the configurable approval workflow governing this document. */
  workflowType: DocWorkflowType | null
  /** SPEC 87 — id of the approval-authority request currently tracking it. */
  approvalRequestId: number | null
  approvedBy: number | null
  approvedAt: string | null
  expiresAt: string | null
  createdBy: number | null
  createdAt: string | null
  updatedAt: string | null
  // Enriched / joined fields (optional, populated on detail reads).
  categoryName?: string | null
  folderName?: string | null
  tags?: DmsTag[]
  file?: DmsDocumentFile | null
  expired?: boolean
  /** Access level the requesting user holds; populated by listAccessibleDocuments. */
  access?: AccessLevel | null
}

export type DmsDocumentFile = {
  id: number
  fileRef: string
  filename: string | null
  mimeType: string | null
  size: number
  version: number
  checksum: string | null
  classification: string
  retentionPolicy: string
  retentionExpiresAt: string | null
  legalHold: boolean
  objectKey: string
  createdAt: string | null
}

export type DmsPermission = {
  id: number
  documentId: number | null
  folderId: number | null
  subjectType: SubjectType
  subjectId: string
  accessLevel: AccessLevel
  createdBy: number | null
  createdAt: string | null
}

export type DmsShare = {
  id: number
  documentId: number
  token: string
  access: ShareAccess
  /** SPEC 89 — who the link is for and how it is gated. */
  recipientType: ShareRecipientType
  /** userId (internal), role (team) or email (external); null for open links. */
  recipient: string | null
  /** Optional friendly name so a link can be identified in the console. */
  label: string | null
  /** True when a password is required. The hash itself is never projected. */
  hasPassword: boolean
  /** Per-link download cap; null means unlimited (subject to access level). */
  maxDownloads: number | null
  expiresAt: string | null
  revokedAt: string | null
  downloadCount: number
  viewCount: number
  lastAccessedAt: string | null
  createdBy: number | null
  createdAt: string | null
  // Enriched fields (populated on tenant-wide console reads).
  documentTitle?: string | null
  docRef?: string | null
}

/** A single recorded access against a share link (SPEC 89 access audit). */
export type DmsShareAccessEntry = {
  id: number
  shareId: number | null
  documentId: number | null
  action: string
  detail: string | null
  userId: number | null
  createdAt: string | null
}

export type DmsAuditEntry = {
  id: number
  documentId: number | null
  action: string
  detail: string | null
  userId: number | null
  createdAt: string | null
}
