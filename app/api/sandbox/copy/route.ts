import { NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { copyProductionToSandbox, SandboxError } from "@/lib/sandbox/service"

/**
 * Sanitized production → sandbox copy (tenant-admin, enterprise-only).
 * Secret-bearing keys are redacted server-side before anything lands in the
 * sandbox. Idempotent via `Idempotency-Key` header (or body `idempotencyKey`).
 */
export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await request.json().catch(() => ({}))
  const idempotencyKey =
    request.headers.get("idempotency-key")?.trim() ||
    (typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "") ||
    null
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const result = await copyProductionToSandbox(actor, idempotencyKey)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof SandboxError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error("[v0] sandbox copy error:", err)
    return NextResponse.json({ error: "Sandbox copy failed" }, { status: 500 })
  }
}
