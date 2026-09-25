import "server-only"
/**
 * SPEC 20 (req #75) — request-time helpers for AI Anomaly Detection routes.
 * Bridges the authenticated session + tenant context to the service Actor model
 * and enforces the feature permission. Mirrors the document-intelligence helper
 * so the two AI modules stay consistent.
 */
import { NextResponse } from "next/server"
import { getSession, type SessionPayload } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { userHasFeature } from "@/lib/permissions"
import type { Actor } from "./service"

/** Permission slug guarding read access to the risk queue. */
export const ANOMALY_VIEW_FEATURE = "ai.anomaly_detection"
/** Permission slug guarding scans and review decisions (write actions). */
export const ANOMALY_MANAGE_FEATURE = "ai.anomaly_detection.manage"

export type AnomalyContext = {
  session: SessionPayload
  actor: Actor
  tenantId: number
}

/**
 * Resolve session + tenant + permission, or return an error response to
 * short-circuit the handler. `requireManage` gates state-changing actions
 * (scan, review) behind write capability. Never throws for the auth path.
 */
export async function requireAnomaly(opts: { requireManage?: boolean } = {}): Promise<AnomalyContext | NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const tenantId = currentTenantIdOrNull()
  if (tenantId == null) {
    return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  }

  const feature = opts.requireManage ? ANOMALY_MANAGE_FEATURE : ANOMALY_VIEW_FEATURE
  const allowed = await userHasFeature(session.userId, session.role, feature)
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  return {
    session,
    actor: { userId: session.userId, role: session.role, isAdmin: session.role === "admin" },
    tenantId,
  }
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse
}

/** Map a service `status` error into a NextResponse. */
export function serviceError(err: { error: string; status: number }): NextResponse {
  return NextResponse.json({ error: err.error }, { status: err.status })
}
