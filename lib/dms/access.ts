import "server-only"
/**
 * SPEC 86 — request-time access resolution for the DMS.
 * Bridges the authenticated session to the pure permission logic in ./model,
 * pulling a document's direct + inherited folder grants from the store.
 */
import { getSession, type SessionPayload } from "@/lib/auth"
import { resolveDocumentGrants } from "./store"
import { resolveEffectiveAccess, type AccessLevel } from "./model"
import type { DmsDocument } from "./types"

export function isTenantAdmin(session: SessionPayload): boolean {
  return session.role === "admin"
}

/**
 * Highest access level the session holds on a document. Owner/creator and
 * tenant admins always resolve to `manage`; everyone else is limited to the
 * strongest explicit grant on the document or one of its ancestor folders.
 */
export async function accessForDocument(
  session: SessionPayload,
  doc: Pick<DmsDocument, "id" | "folderId" | "ownerId" | "createdBy">,
): Promise<AccessLevel | null> {
  const grants = await resolveDocumentGrants({ id: doc.id, folderId: doc.folderId })
  return resolveEffectiveAccess({
    userId: session.userId,
    role: session.role,
    isAdmin: isTenantAdmin(session),
    isOwner: doc.ownerId === session.userId || doc.createdBy === session.userId,
    grants,
  })
}

export { getSession }
