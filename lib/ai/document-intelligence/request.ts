import "server-only"
/**
 * SPEC 19 (req #74) — request-time helpers for AI Document Intelligence routes.
 * Bridges the authenticated session + tenant context to the service Actor model,
 * enforces the feature permission, and resolves whether the tenant is authorized
 * to run AI extraction (the second half of the fail-closed processing gate).
 */
import { NextResponse } from "next/server"
import { getSession, type SessionPayload } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { userHasFeature } from "@/lib/permissions"
import { isModuleEnabled } from "@/lib/settings/server"
import type { Actor } from "./service"

/** Permission slug guarding every document-intelligence action. */
export const DOC_INTEL_FEATURE = "ai.document_intelligence"

export type DocIntelContext = {
  session: SessionPayload
  actor: Actor
  tenantId: number
  /** Tenant-level authorization for AI processing (module toggle). */
  tenantAuthorized: boolean
}

/**
 * Resolve session + tenant + permission, or return an error response to
 * short-circuit the handler. Never throws for the auth path.
 */
export async function requireDocIntel(): Promise<DocIntelContext | NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const tenantId = currentTenantIdOrNull()
  if (tenantId == null) {
    return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  }

  const allowed = await userHasFeature(session.userId, session.role, DOC_INTEL_FEATURE)
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const tenantAuthorized = await isModuleEnabled("ai")

  return {
    session,
    actor: { userId: session.userId, role: session.role, isAdmin: session.role === "admin" },
    tenantId,
    tenantAuthorized,
  }
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse
}

/** Map a service `status` error into a NextResponse. */
export function serviceError(err: { error: string; status: number }): NextResponse {
  return NextResponse.json({ error: err.error }, { status: err.status })
}
