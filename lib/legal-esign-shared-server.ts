import "server-only"
import type { NextRequest } from "next/server"

/** Best-effort client IP for the signature audit trail (Phase 61). */
export function clientIp(request: NextRequest): string | null {
  const fwd = request.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0].trim()
  return request.headers.get("x-real-ip") || null
}
