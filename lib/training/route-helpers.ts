import "server-only"
import { NextResponse } from "next/server"
import { getSession, type SessionPayload } from "@/lib/auth"
import { requireModuleAction } from "@/lib/api-auth"
import { TrainingError } from "./store"

/**
 * Spec38 route helpers. Learner endpoints require any authenticated session;
 * management endpoints (authoring courses, assigning, publishing policies,
 * reading tenant-wide rosters) require an HR write/read grant — admins always
 * pass via requireModuleAction.
 */

export type ManagerAction = "view" | "add" | "update" | "delete"

export async function requireManager(action: ManagerAction): Promise<SessionPayload | null> {
  return requireModuleAction("hr", action)
}

export async function requireLearner(): Promise<SessionPayload | null> {
  return getSession()
}

/** Is the current session an HR manager (used for media access decisions)? */
export async function isManagerSession(): Promise<boolean> {
  return (await requireModuleAction("hr", "view")) != null
}

export function forbidden(message = "Forbidden") {
  return NextResponse.json({ error: message }, { status: 403 })
}

/** Wrap a handler so TrainingError -> its status and anything else -> 500. */
export async function run<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const data = await fn()
    return NextResponse.json(data ?? { ok: true })
  } catch (err) {
    if (err instanceof TrainingError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.log("[v0] training route error:", err instanceof Error ? err.message : err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}

export function parseId(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new TrainingError("Invalid id", 400)
  return n
}

/** Best-effort client IP for acknowledgment evidence. */
export function clientIp(request: Request): string | null {
  const xf = request.headers.get("x-forwarded-for")
  if (xf) return xf.split(",")[0]!.trim()
  return request.headers.get("x-real-ip")
}
