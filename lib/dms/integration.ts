import "server-only"
/**
 * SPEC 86 — Document Management System module integration surface.
 * ---------------------------------------------------------------------------
 * The centralized DMS is the single source of truth for enterprise documents.
 * Other modules (HR, Finance, CRM, Projects, Procurement, …) do NOT invent their
 * own document tables — they register their files here, linked back to the
 * originating record via (source_module, source_entity_type, source_entity_id).
 *
 * This module is the ONLY thing those callers need to import. It wraps the store
 * so every module writes documents in a consistent, tenant-scoped, audited way
 * and can list the documents that belong to one of its records.
 *
 * Typical usage from a module (e.g. HR attaching an offer letter):
 *
 *   import { uploadFile } from "@/lib/storage"
 *   import { registerModuleDocument } from "@/lib/dms/integration"
 *
 *   const up = await uploadFile(key, file, { metadata: { module: "hr", ... } })
 *   await registerModuleDocument({
 *     module: "hr", entityType: "employee", entityId: employeeId,
 *     title: "Offer Letter", fileId: up.result.file.id, createdBy: userId,
 *   })
 */
import {
  createDocument,
  listAccessibleDocuments,
  logAudit,
  type DmsActor,
  type DocumentFilter,
} from "./store"
import type { DmsDocument } from "./types"
import type { DocStatus } from "./model"

/** Well-known module identifiers the DMS integrates with. */
export const DMS_SOURCE_MODULES = [
  "hr",
  "finance",
  "crm",
  "projects",
  "procurement",
  "sales",
  "support",
  "legal",
] as const
export type DmsSourceModule = (typeof DMS_SOURCE_MODULES)[number]

export type RegisterModuleDocumentInput = {
  /** Originating module, e.g. "hr" | "finance" | "crm" | "projects" | "procurement". */
  module: string
  /** Entity kind within the module, e.g. "employee", "invoice", "deal", "project", "purchase_order". */
  entityType: string
  /** Primary key of the originating record (coerced to string for stable storage). */
  entityId: string | number
  title: string
  description?: string | null
  /** id of an already-uploaded file_objects row (upload via lib/storage first). */
  fileId?: number | null
  folderId?: number | null
  categoryId?: number | null
  ownerId?: number | null
  createdBy?: number | null
  status?: DocStatus
  expiresAt?: string | null
  tags?: string[]
}

/**
 * Register a document produced by another module into the central DMS, linked
 * back to the originating record. Returns the created DMS document. The write is
 * tenant-scoped (via the store) and audited.
 */
export async function registerModuleDocument(
  input: RegisterModuleDocumentInput,
): Promise<DmsDocument> {
  const doc = await createDocument({
    title: input.title,
    description: input.description ?? null,
    folderId: input.folderId ?? null,
    categoryId: input.categoryId ?? null,
    ownerId: input.ownerId ?? null,
    fileId: input.fileId ?? null,
    sourceModule: input.module,
    sourceEntityType: input.entityType,
    sourceEntityId: String(input.entityId),
    status: input.status ?? "published",
    expiresAt: input.expiresAt ?? null,
    createdBy: input.createdBy ?? null,
    tags: input.tags,
  })
  await logAudit({
    documentId: doc.id,
    action: "register",
    detail: `${input.module}:${input.entityType}:${input.entityId}`,
    userId: input.createdBy ?? input.ownerId ?? null,
  })
  return doc
}

/**
 * List the DMS documents linked to a specific module record, filtered to what
 * the acting user may at least view. Powers per-record "Documents" panels shown
 * inside HR / Finance / CRM / Projects / Procurement screens.
 */
export async function listEntityDocuments(
  actor: DmsActor,
  ref: { module: string; entityType: string; entityId: string | number },
  extra: Pick<DocumentFilter, "status" | "search" | "limit"> = {},
): Promise<DmsDocument[]> {
  return listAccessibleDocuments(actor, {
    sourceModule: ref.module,
    sourceEntityType: ref.entityType,
    sourceEntityId: String(ref.entityId),
    ...extra,
  })
}

/** List every DMS document that originated from a given module (across records). */
export async function listModuleDocuments(
  actor: DmsActor,
  module: string,
  extra: Pick<DocumentFilter, "status" | "search" | "limit"> = {},
): Promise<DmsDocument[]> {
  return listAccessibleDocuments(actor, { sourceModule: module, ...extra })
}
