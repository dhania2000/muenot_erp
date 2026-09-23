import "server-only"
/**
 * SPEC 86 — Document Management System data-access layer.
 * ---------------------------------------------------------------------------
 * Every read/write goes through the tenant-scoped helpers (lib/tenant-scope.ts)
 * so DMS rows can never span tenants. Document bytes / versions / retention are
 * delegated to the existing file_objects store (lib/storage).
 */
import { query } from "@/lib/db"
import {
  currentTenantId,
  tenantSelect,
  tenantFindById,
  tenantInsert,
  tenantUpdate,
  tenantDelete,
  scopedWhere,
} from "@/lib/tenant-scope"
import { getFileById, listFileMetadata, formatFileRef, type FileObject } from "@/lib/storage"
import { ensureDmsSchema } from "./schema"
import {
  formatDocRef,
  normalizeAccessLevel,
  normalizeApproval,
  normalizeShareAccess,
  normalizeStatus,
  normalizeSubjectType,
  isExpired,
  resolveEffectiveAccess,
  ancestorIdsFromMap,
  type AccessGrant,
  type AccessLevel,
  type ApprovalStatus,
  type DocStatus,
  type ShareAccess,
  type SubjectType,
} from "./model"
import type {
  DmsAuditEntry,
  DmsCategory,
  DmsDocument,
  DmsDocumentFile,
  DmsFolder,
  DmsPermission,
  DmsShare,
  DmsTag,
} from "./types"

/**
 * Stable file_objects coordinates for DMS-managed bytes. Every document version
 * is stored under these so `listDocumentVersions` can find the whole chain.
 */
export const DMS_MODULE = "dms"
export const DMS_ENTITY_TYPE = "document"

// ---------------------------------------------------------------------------
// Row → projection mappers
// ---------------------------------------------------------------------------

function mapFolder(r: any): DmsFolder {
  return {
    id: Number(r.id),
    name: r.name,
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
    documentCount: r.document_count == null ? undefined : Number(r.document_count),
  }
}

function mapCategory(r: any): DmsCategory {
  return {
    id: Number(r.id),
    name: r.name,
    color: r.color ?? null,
    description: r.description ?? null,
    documentCount: r.document_count == null ? undefined : Number(r.document_count),
  }
}

function mapTag(r: any): DmsTag {
  return {
    id: Number(r.id),
    name: r.name,
    documentCount: r.document_count == null ? undefined : Number(r.document_count),
  }
}

function mapDocument(r: any): DmsDocument {
  return {
    id: Number(r.id),
    docRef: formatDocRef(Number(r.id)),
    title: r.title,
    description: r.description ?? null,
    folderId: r.folder_id == null ? null : Number(r.folder_id),
    categoryId: r.category_id == null ? null : Number(r.category_id),
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    fileId: r.file_id == null ? null : Number(r.file_id),
    sourceModule: r.source_module ?? null,
    sourceEntityType: r.source_entity_type ?? null,
    sourceEntityId: r.source_entity_id ?? null,
    status: normalizeStatus(r.status),
    approvalStatus: normalizeApproval(r.approval_status),
    approvedBy: r.approved_by == null ? null : Number(r.approved_by),
    approvedAt: r.approved_at ?? null,
    expiresAt: r.expires_at ?? null,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
    categoryName: r.category_name ?? null,
    folderName: r.folder_name ?? null,
    expired: isExpired(r.expires_at),
  }
}

function mapPermission(r: any): DmsPermission {
  return {
    id: Number(r.id),
    documentId: r.document_id == null ? null : Number(r.document_id),
    folderId: r.folder_id == null ? null : Number(r.folder_id),
    subjectType: normalizeSubjectType(r.subject_type),
    subjectId: String(r.subject_id),
    accessLevel: normalizeAccessLevel(r.access_level),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at ?? null,
  }
}

function mapShare(r: any): DmsShare {
  return {
    id: Number(r.id),
    documentId: Number(r.document_id),
    token: r.token,
    access: normalizeShareAccess(r.access),
    expiresAt: r.expires_at ?? null,
    revokedAt: r.revoked_at ?? null,
    downloadCount: Number(r.download_count ?? 0),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at ?? null,
  }
}

function mapAudit(r: any): DmsAuditEntry {
  return {
    id: Number(r.id),
    documentId: r.document_id == null ? null : Number(r.document_id),
    action: r.action,
    detail: r.detail ?? null,
    userId: r.user_id == null ? null : Number(r.user_id),
    createdAt: r.created_at ?? null,
  }
}

function mapFile(f: FileObject): DmsDocumentFile {
  return {
    id: f.id,
    fileRef: f.fileRef || formatFileRef(f.id),
    filename: f.filename,
    mimeType: f.mimeType,
    size: f.size,
    version: f.version,
    checksum: f.checksum,
    classification: f.classification,
    retentionPolicy: f.retentionPolicy,
    retentionExpiresAt: f.retentionExpiresAt,
    legalHold: f.legalHold,
    objectKey: f.objectKey,
    createdAt: f.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function listFolders(): Promise<DmsFolder[]> {
  await ensureDmsSchema()
  const { where, params } = scopedWhere("dms_folders", "", [], { alias: "f" })
  const rows = await query<any[]>(
    `SELECT f.*, (
        SELECT COUNT(*) FROM dms_documents d
        WHERE d.tenant_id = f.tenant_id AND d.folder_id = f.id AND d.deleted_at IS NULL
      ) AS document_count
     FROM dms_folders f ${where} ORDER BY f.name ASC`,
    params,
  )
  return rows.map(mapFolder)
}

export async function createFolder(input: {
  name: string
  parentId?: number | null
  ownerId?: number | null
  createdBy?: number | null
}): Promise<DmsFolder> {
  await ensureDmsSchema()
  const { insertId } = await tenantInsert("dms_folders", {
    name: input.name.trim().slice(0, 255) || "Untitled folder",
    parent_id: input.parentId ?? null,
    owner_id: input.ownerId ?? null,
    created_by: input.createdBy ?? null,
  })
  const row = await tenantFindById("dms_folders", insertId)
  return mapFolder(row)
}

export async function updateFolder(
  id: number,
  patch: { name?: string; parentId?: number | null },
): Promise<boolean> {
  await ensureDmsSchema()
  const set: Record<string, any> = {}
  if (patch.name != null) set.name = patch.name.trim().slice(0, 255)
  if (patch.parentId !== undefined) set.parent_id = patch.parentId
  if (Object.keys(set).length === 0) return false
  const n = await tenantUpdate("dms_folders", set, "id = ?", [id])
  return n > 0
}

export async function deleteFolder(id: number): Promise<boolean> {
  await ensureDmsSchema()
  // Reparent children + detach documents so nothing is orphaned by tenant id.
  await tenantUpdate("dms_folders", { parent_id: null }, "parent_id = ?", [id])
  await tenantUpdate("dms_documents", { folder_id: null }, "folder_id = ?", [id])
  await tenantDelete("dms_document_permissions", "folder_id = ?", [id])
  const n = await tenantDelete("dms_folders", "id = ?", [id])
  return n > 0
}

/** Ids of a folder plus all of its ancestors (for permission inheritance). */
export async function folderAncestorIds(folderId: number | null): Promise<number[]> {
  if (folderId == null) return []
  await ensureDmsSchema()
  const ids: number[] = []
  let current: number | null = folderId
  const seen = new Set<number>()
  while (current != null && !seen.has(current)) {
    seen.add(current)
    ids.push(current)
    const row = await tenantFindById<any>("dms_folders", current)
    current = row?.parent_id == null ? null : Number(row.parent_id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function listCategories(): Promise<DmsCategory[]> {
  await ensureDmsSchema()
  const { where, params } = scopedWhere("dms_categories", "", [], { alias: "c" })
  const rows = await query<any[]>(
    `SELECT c.*, (
        SELECT COUNT(*) FROM dms_documents d
        WHERE d.tenant_id = c.tenant_id AND d.category_id = c.id AND d.deleted_at IS NULL
      ) AS document_count
     FROM dms_categories c ${where} ORDER BY c.name ASC`,
    params,
  )
  return rows.map(mapCategory)
}

export async function createCategory(input: {
  name: string
  color?: string | null
  description?: string | null
}): Promise<DmsCategory> {
  await ensureDmsSchema()
  const name = input.name.trim().slice(0, 120)
  // Upsert-ish: reuse an existing same-named category for this tenant.
  const existing = await tenantSelect<any[]>("dms_categories", {
    where: "name = ?",
    params: [name],
    tail: "LIMIT 1",
  })
  if (existing[0]) return mapCategory(existing[0])
  const { insertId } = await tenantInsert("dms_categories", {
    name,
    color: input.color?.slice(0, 20) ?? null,
    description: input.description?.slice(0, 500) ?? null,
  })
  const row = await tenantFindById("dms_categories", insertId)
  return mapCategory(row)
}

export async function updateCategory(
  id: number,
  patch: { name?: string; color?: string | null; description?: string | null },
): Promise<boolean> {
  await ensureDmsSchema()
  const set: Record<string, any> = {}
  if (patch.name != null) set.name = patch.name.trim().slice(0, 120)
  if (patch.color !== undefined) set.color = patch.color?.slice(0, 20) ?? null
  if (patch.description !== undefined) set.description = patch.description?.slice(0, 500) ?? null
  if (Object.keys(set).length === 0) return false
  return (await tenantUpdate("dms_categories", set, "id = ?", [id])) > 0
}

export async function deleteCategory(id: number): Promise<boolean> {
  await ensureDmsSchema()
  await tenantUpdate("dms_documents", { category_id: null }, "category_id = ?", [id])
  return (await tenantDelete("dms_categories", "id = ?", [id])) > 0
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export async function listTags(): Promise<DmsTag[]> {
  await ensureDmsSchema()
  const { where, params } = scopedWhere("dms_tags", "", [], { alias: "t" })
  const rows = await query<any[]>(
    `SELECT t.*, (
        SELECT COUNT(*) FROM dms_document_tags dt
        WHERE dt.tenant_id = t.tenant_id AND dt.tag_id = t.id
      ) AS document_count
     FROM dms_tags t ${where} ORDER BY t.name ASC`,
    params,
  )
  return rows.map(mapTag)
}

/** Resolve tag names to ids for the current tenant, creating any that are new. */
export async function upsertTags(names: string[]): Promise<number[]> {
  await ensureDmsSchema()
  const clean = Array.from(
    new Set(names.map((n) => n.trim().slice(0, 80)).filter((n) => n.length > 0)),
  )
  const ids: number[] = []
  for (const name of clean) {
    const existing = await tenantSelect<any[]>("dms_tags", {
      where: "name = ?",
      params: [name],
      tail: "LIMIT 1",
    })
    if (existing[0]) {
      ids.push(Number(existing[0].id))
      continue
    }
    const { insertId } = await tenantInsert("dms_tags", { name })
    ids.push(insertId)
  }
  return ids
}

export async function getDocumentTags(documentId: number): Promise<DmsTag[]> {
  await ensureDmsSchema()
  const { where, params } = scopedWhere("dms_document_tags", "dt.document_id = ?", [documentId], {
    alias: "dt",
  })
  const rows = await query<any[]>(
    `SELECT t.id, t.name FROM dms_document_tags dt
       JOIN dms_tags t ON t.id = dt.tag_id AND t.tenant_id = dt.tenant_id
     ${where} ORDER BY t.name ASC`,
    params,
  )
  return rows.map(mapTag)
}

export async function setDocumentTags(documentId: number, tagNames: string[]): Promise<void> {
  await ensureDmsSchema()
  const tagIds = await upsertTags(tagNames)
  await tenantDelete("dms_document_tags", "document_id = ?", [documentId])
  for (const tagId of tagIds) {
    await tenantInsert("dms_document_tags", { document_id: documentId, tag_id: tagId })
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentFilter = {
  folderId?: number | null
  categoryId?: number | null
  tagId?: number | null
  status?: DocStatus
  search?: string
  sourceModule?: string
  ownerId?: number
  limit?: number
}

export async function listDocuments(filter: DocumentFilter = {}): Promise<DmsDocument[]> {
  await ensureDmsSchema()
  const clauses: string[] = ["d.deleted_at IS NULL"]
  const extra: any[] = []
  if (filter.folderId !== undefined) {
    if (filter.folderId === null) clauses.push("d.folder_id IS NULL")
    else {
      clauses.push("d.folder_id = ?")
      extra.push(filter.folderId)
    }
  }
  if (filter.categoryId != null) {
    clauses.push("d.category_id = ?")
    extra.push(filter.categoryId)
  }
  if (filter.status) {
    clauses.push("d.status = ?")
    extra.push(filter.status)
  }
  if (filter.sourceModule) {
    clauses.push("d.source_module = ?")
    extra.push(filter.sourceModule)
  }
  if (filter.ownerId != null) {
    clauses.push("d.owner_id = ?")
    extra.push(filter.ownerId)
  }
  if (filter.search) {
    clauses.push("(d.title LIKE ? OR d.description LIKE ?)")
    const like = `%${filter.search.slice(0, 100)}%`
    extra.push(like, like)
  }
  if (filter.tagId != null) {
    clauses.push(
      "EXISTS (SELECT 1 FROM dms_document_tags dt WHERE dt.tenant_id = d.tenant_id AND dt.document_id = d.id AND dt.tag_id = ?)",
    )
    extra.push(filter.tagId)
  }
  const { where, params } = scopedWhere("dms_documents", clauses.join(" AND "), extra, { alias: "d" })
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500)
  const rows = await query<any[]>(
    `SELECT d.*, c.name AS category_name, f.name AS folder_name
       FROM dms_documents d
       LEFT JOIN dms_categories c ON c.id = d.category_id AND c.tenant_id = d.tenant_id
       LEFT JOIN dms_folders f ON f.id = d.folder_id AND f.tenant_id = d.tenant_id
     ${where} ORDER BY d.updated_at DESC LIMIT ${limit}`,
    params,
  )
  return rows.map(mapDocument)
}

export type DmsActor = { userId: number; role: string; isAdmin: boolean }

/**
 * List documents the actor may at least view, each tagged with the access level
 * they hold. Loads the folder tree and every permission ONCE, then resolves
 * inheritance in memory — so filtering a page of documents is a few queries,
 * not one per document. Documents with no explicit grant are open to the tenant
 * (view), while edit/delete/manage still require an explicit grant or ownership.
 */
export async function listAccessibleDocuments(
  actor: DmsActor,
  filter: DocumentFilter = {},
): Promise<DmsDocument[]> {
  const docs = await listDocuments(filter)
  if (docs.length === 0) return []
  const parents = await getFolderParentMap()
  const perms = await listAllPermissions()
  const byDoc = new Map<number, AccessGrant[]>()
  const byFolder = new Map<number, AccessGrant[]>()
  for (const p of perms) {
    const grant: AccessGrant = {
      subjectType: p.subjectType,
      subjectId: p.subjectId,
      accessLevel: p.accessLevel,
    }
    if (p.documentId != null) push(byDoc, p.documentId, grant)
    else if (p.folderId != null) push(byFolder, p.folderId, grant)
  }
  const out: DmsDocument[] = []
  for (const d of docs) {
    const grants: AccessGrant[] = [...(byDoc.get(d.id) ?? [])]
    for (const fid of ancestorIdsFromMap(d.folderId, parents)) {
      const fg = byFolder.get(fid)
      if (fg) grants.push(...fg)
    }
    const isOwner = d.ownerId === actor.userId || d.createdBy === actor.userId
    let access = resolveEffectiveAccess({
      userId: actor.userId,
      role: actor.role,
      isAdmin: actor.isAdmin,
      isOwner,
      grants,
    })
    if (access == null && grants.length === 0) access = "view" // open by default
    if (access == null) continue
    out.push({ ...d, access })
  }
  return out
}

function push<T>(map: Map<number, T[]>, key: number, value: T): void {
  const arr = map.get(key)
  if (arr) arr.push(value)
  else map.set(key, [value])
}

/** Map of folder id → parent id for the tenant (one query). */
export async function getFolderParentMap(): Promise<Map<number, number | null>> {
  await ensureDmsSchema()
  const rows = await tenantSelect<any[]>("dms_folders", { columns: "id, parent_id" })
  const map = new Map<number, number | null>()
  for (const r of rows) map.set(Number(r.id), r.parent_id == null ? null : Number(r.parent_id))
  return map
}

/** Every permission row for the tenant (one query). */
export async function listAllPermissions(): Promise<DmsPermission[]> {
  await ensureDmsSchema()
  const rows = await tenantSelect<any[]>("dms_document_permissions", {})
  return rows.map(mapPermission)
}

/** Full document detail (with tags + current file), or null if not owned/missing. */
export async function getDocument(id: number): Promise<DmsDocument | null> {
  await ensureDmsSchema()
  const row = await tenantFindById<any>("dms_documents", id)
  if (!row || row.deleted_at) return null
  const doc = mapDocument(row)
  doc.tags = await getDocumentTags(id)
  if (doc.fileId != null) {
    const file = await getFileById(doc.fileId).catch(() => null)
    doc.file = file ? mapFile(file) : null
  }
  return doc
}

export async function createDocument(input: {
  title: string
  description?: string | null
  folderId?: number | null
  categoryId?: number | null
  ownerId?: number | null
  fileId?: number | null
  sourceModule?: string | null
  sourceEntityType?: string | null
  sourceEntityId?: string | null
  status?: DocStatus
  expiresAt?: string | null
  createdBy?: number | null
  tags?: string[]
}): Promise<DmsDocument> {
  await ensureDmsSchema()
  const { insertId } = await tenantInsert("dms_documents", {
    title: input.title.trim().slice(0, 300) || "Untitled document",
    description: input.description ?? null,
    folder_id: input.folderId ?? null,
    category_id: input.categoryId ?? null,
    owner_id: input.ownerId ?? null,
    file_id: input.fileId ?? null,
    source_module: input.sourceModule ?? null,
    source_entity_type: input.sourceEntityType ?? null,
    source_entity_id: input.sourceEntityId ?? null,
    status: normalizeStatus(input.status ?? "active"),
    expires_at: input.expiresAt ?? null,
    created_by: input.createdBy ?? null,
  })
  if (input.tags?.length) await setDocumentTags(insertId, input.tags)
  const doc = await getDocument(insertId)
  return doc!
}

export async function updateDocument(
  id: number,
  patch: {
    title?: string
    description?: string | null
    folderId?: number | null
    categoryId?: number | null
    ownerId?: number | null
    status?: DocStatus
    expiresAt?: string | null
    fileId?: number | null
    tags?: string[]
  },
): Promise<boolean> {
  await ensureDmsSchema()
  const set: Record<string, any> = {}
  if (patch.title != null) set.title = patch.title.trim().slice(0, 300)
  if (patch.description !== undefined) set.description = patch.description
  if (patch.folderId !== undefined) set.folder_id = patch.folderId
  if (patch.categoryId !== undefined) set.category_id = patch.categoryId
  if (patch.ownerId !== undefined) set.owner_id = patch.ownerId
  if (patch.status != null) set.status = normalizeStatus(patch.status)
  if (patch.expiresAt !== undefined) set.expires_at = patch.expiresAt
  if (patch.fileId !== undefined) set.file_id = patch.fileId
  let changed = false
  if (Object.keys(set).length > 0) {
    changed = (await tenantUpdate("dms_documents", set, "id = ? AND deleted_at IS NULL", [id])) > 0
  }
  if (patch.tags !== undefined) {
    await setDocumentTags(id, patch.tags ?? [])
    changed = true
  }
  return changed
}

/** Point a document at a new current file version (after a re-upload). */
export async function setDocumentFile(id: number, fileId: number): Promise<boolean> {
  await ensureDmsSchema()
  return (await tenantUpdate("dms_documents", { file_id: fileId }, "id = ?", [id])) > 0
}

/**
 * Every uploaded file for a document, newest first. Keyed on the file_objects
 * entity (module=dms / entity_type=document / entity_id=<docId>) so it captures
 * the full version chain regardless of per-version filename changes.
 */
export async function listDocumentVersions(documentId: number): Promise<DmsDocumentFile[]> {
  await ensureDmsSchema()
  const files = await listFileMetadata({
    module: DMS_MODULE,
    entityType: DMS_ENTITY_TYPE,
    entityId: String(documentId),
    includeDeleted: true,
  })
  return files.map(mapFile)
}

export async function setApproval(
  id: number,
  status: ApprovalStatus,
  approverId: number | null,
): Promise<boolean> {
  await ensureDmsSchema()
  const set: Record<string, any> = { approval_status: normalizeApproval(status) }
  if (status === "approved" || status === "rejected") {
    set.approved_by = approverId
    set.approved_at = new Date()
  } else {
    set.approved_by = null
    set.approved_at = null
  }
  return (await tenantUpdate("dms_documents", set, "id = ?", [id])) > 0
}

export async function softDeleteDocument(id: number, userId: number | null): Promise<boolean> {
  await ensureDmsSchema()
  return (
    (await tenantUpdate(
      "dms_documents",
      { deleted_at: new Date(), deleted_by: userId },
      "id = ? AND deleted_at IS NULL",
      [id],
    )) > 0
  )
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function listDocumentPermissions(documentId: number): Promise<DmsPermission[]> {
  await ensureDmsSchema()
  const rows = await tenantSelect<any[]>("dms_document_permissions", {
    where: "document_id = ?",
    params: [documentId],
    tail: "ORDER BY created_at ASC",
  })
  return rows.map(mapPermission)
}

export async function listFolderPermissions(folderId: number): Promise<DmsPermission[]> {
  await ensureDmsSchema()
  const rows = await tenantSelect<any[]>("dms_document_permissions", {
    where: "folder_id = ?",
    params: [folderId],
    tail: "ORDER BY created_at ASC",
  })
  return rows.map(mapPermission)
}

export async function addPermission(input: {
  documentId?: number | null
  folderId?: number | null
  subjectType: SubjectType
  subjectId: string
  accessLevel: AccessLevel
  createdBy?: number | null
}): Promise<DmsPermission> {
  await ensureDmsSchema()
  const subjectType = normalizeSubjectType(input.subjectType)
  const subjectId = String(input.subjectId).slice(0, 120)
  const accessLevel = normalizeAccessLevel(input.accessLevel)
  // Replace an existing grant for the same subject on the same target.
  const target = input.documentId != null ? "document_id = ?" : "folder_id = ?"
  const targetId = input.documentId != null ? input.documentId : input.folderId
  await tenantDelete(
    "dms_document_permissions",
    `${target} AND subject_type = ? AND subject_id = ?`,
    [targetId, subjectType, subjectId],
  )
  const { insertId } = await tenantInsert("dms_document_permissions", {
    document_id: input.documentId ?? null,
    folder_id: input.folderId ?? null,
    subject_type: subjectType,
    subject_id: subjectId,
    access_level: accessLevel,
    created_by: input.createdBy ?? null,
  })
  const row = await tenantFindById("dms_document_permissions", insertId)
  return mapPermission(row)
}

export async function removePermission(id: number): Promise<boolean> {
  await ensureDmsSchema()
  return (await tenantDelete("dms_document_permissions", "id = ?", [id])) > 0
}

/**
 * All grants that apply to a document: its direct grants plus grants inherited
 * from its folder and every ancestor folder. Powers effective-access checks.
 */
export async function resolveDocumentGrants(doc: {
  id: number
  folderId: number | null
}): Promise<AccessGrant[]> {
  await ensureDmsSchema()
  const folderIds = await folderAncestorIds(doc.folderId)
  const parts: string[] = ["document_id = ?"]
  const params: any[] = [doc.id]
  if (folderIds.length) {
    parts.push(`folder_id IN (${folderIds.map(() => "?").join(",")})`)
    params.push(...folderIds)
  }
  const rows = await tenantSelect<any[]>("dms_document_permissions", {
    where: parts.join(" OR "),
    params,
  })
  return rows.map((r) => ({
    subjectType: normalizeSubjectType(r.subject_type),
    subjectId: String(r.subject_id),
    accessLevel: normalizeAccessLevel(r.access_level),
  }))
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export async function listShares(documentId: number): Promise<DmsShare[]> {
  await ensureDmsSchema()
  const rows = await tenantSelect<any[]>("dms_document_shares", {
    where: "document_id = ?",
    params: [documentId],
    tail: "ORDER BY created_at DESC",
  })
  return rows.map(mapShare)
}

export async function createShare(input: {
  documentId: number
  token: string
  access: ShareAccess
  expiresAt?: string | null
  createdBy?: number | null
}): Promise<DmsShare> {
  await ensureDmsSchema()
  const { insertId } = await tenantInsert("dms_document_shares", {
    document_id: input.documentId,
    token: input.token,
    access: normalizeShareAccess(input.access),
    expires_at: input.expiresAt ?? null,
    created_by: input.createdBy ?? null,
  })
  const row = await tenantFindById("dms_document_shares", insertId)
  return mapShare(row)
}

export async function revokeShare(id: number): Promise<boolean> {
  await ensureDmsSchema()
  return (await tenantUpdate("dms_document_shares", { revoked_at: new Date() }, "id = ?", [id])) > 0
}

/**
 * Look up a share by token WITHOUT a tenant filter — this is the only DMS read
 * that runs before a tenant context exists (public share links). It returns the
 * owning tenant id so the caller can bind context before touching the file.
 */
export async function getShareByToken(token: string): Promise<{
  share: DmsShare
  tenantId: number
} | null> {
  await ensureDmsSchema()
  const rows = await query<any[]>(
    `SELECT * FROM dms_document_shares WHERE token = ? LIMIT 1`,
    [token],
  )
  if (!rows[0]) return null
  return { share: mapShare(rows[0]), tenantId: Number(rows[0].tenant_id) }
}

export async function incrementShareDownload(id: number): Promise<void> {
  await ensureDmsSchema()
  const { where, params } = scopedWhere("dms_document_shares", "id = ?", [id])
  await query(
    `UPDATE dms_document_shares SET download_count = download_count + 1 ${where}`,
    params,
  )
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function logAudit(input: {
  documentId?: number | null
  action: string
  detail?: string | null
  userId?: number | null
}): Promise<void> {
  await ensureDmsSchema()
  try {
    await tenantInsert("dms_audit", {
      document_id: input.documentId ?? null,
      action: input.action.slice(0, 40),
      detail: input.detail?.slice(0, 1000) ?? null,
      user_id: input.userId ?? null,
    })
  } catch (err) {
    // Audit must never break the primary operation.
    console.error("[v0] dms audit log failed:", err)
  }
}

export async function listAudit(documentId?: number, limit = 100): Promise<DmsAuditEntry[]> {
  await ensureDmsSchema()
  const cap = Math.min(Math.max(limit, 1), 500)
  const rows = await tenantSelect<any[]>("dms_audit", {
    where: documentId != null ? "document_id = ?" : "",
    params: documentId != null ? [documentId] : [],
    tail: `ORDER BY created_at DESC LIMIT ${cap}`,
  })
  return rows.map(mapAudit)
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getDmsStats(): Promise<{
  documents: number
  folders: number
  categories: number
  tags: number
  pendingApproval: number
  expiringSoon: number
}> {
  await ensureDmsSchema()
  const tid = currentTenantId()
  const [docs] = await query<any[]>(
    `SELECT
        COUNT(*) AS documents,
        SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= DATE_ADD(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS expiring
      FROM dms_documents WHERE tenant_id = ? AND deleted_at IS NULL`,
    [tid],
  )
  const [folders] = await query<any[]>(
    `SELECT COUNT(*) AS n FROM dms_folders WHERE tenant_id = ?`,
    [tid],
  )
  const [categories] = await query<any[]>(
    `SELECT COUNT(*) AS n FROM dms_categories WHERE tenant_id = ?`,
    [tid],
  )
  const [tags] = await query<any[]>(`SELECT COUNT(*) AS n FROM dms_tags WHERE tenant_id = ?`, [tid])
  return {
    documents: Number(docs?.documents ?? 0),
    folders: Number(folders?.n ?? 0),
    categories: Number(categories?.n ?? 0),
    tags: Number(tags?.n ?? 0),
    pendingApproval: Number(docs?.pending ?? 0),
    expiringSoon: Number(docs?.expiring ?? 0),
  }
}
