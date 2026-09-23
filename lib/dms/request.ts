import "server-only"
/**
 * SPEC 86 — request-time helpers for DMS route handlers.
 * Bridges the authenticated session + tenant context to the DMS actor model and
 * resolves the effective access level for a document (with the "open by default"
 * view fallback used by listAccessibleDocuments).
 */
import { NextResponse } from "next/server"
import { getSession, type SessionPayload } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { isTenantAdmin } from "./access"
import { resolveDocumentGrants, type DmsActor } from "./store"
import { resolveEffectiveAccess, type AccessLevel } from "./model"
import type { DmsDocument } from "./types"

export type DmsContext = { session: SessionPayload; actor: DmsActor }

/** Resolve the session + tenant, or return an error response to short-circuit. */
export async function requireDms(): Promise<DmsContext | NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (currentTenantIdOrNull() == null) {
    return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  }
  return {
    session,
    actor: { userId: session.userId, role: session.role, isAdmin: isTenantAdmin(session) },
  }
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse
}

/**
 * Highest access level the session holds on a document. Mirrors
 * listAccessibleDocuments: owner/creator and admins get `manage`, an explicit
 * grant wins otherwise, and a document with no grants at all is open (view).
 */
export async function effectiveAccess(
  session: SessionPayload,
  doc: Pick<DmsDocument, "id" | "folderId" | "ownerId" | "createdBy">,
): Promise<AccessLevel | null> {
  const grants = await resolveDocumentGrants({ id: doc.id, folderId: doc.folderId })
  let access = resolveEffectiveAccess({
    userId: session.userId,
    role: session.role,
    isAdmin: isTenantAdmin(session),
    isOwner: doc.ownerId === session.userId || doc.createdBy === session.userId,
    grants,
  })
  if (access == null && grants.length === 0) access = "view"
  return access
}
