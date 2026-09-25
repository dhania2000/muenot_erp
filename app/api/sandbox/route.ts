import { NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { configureSandbox, getSandboxOverview, SandboxError } from "@/lib/sandbox/service"

/**
 * Production sandbox console (tenant-admin, tenant-scoped, enterprise-only).
 * ---------------------------------------------------------------------------
 * GET  — the sandbox environment, isolation state, change pipeline and audit.
 * POST — configure the sandbox environment / connection set. Production
 *        isolation is enforced server-side before anything is persisted.
 *
 * Every read/write is scoped to the caller's tenant via the service layer, and
 * enterprise gating + validation live in the service so they cannot be bypassed.
 */

function fail(err: unknown) {
  if (err instanceof SandboxError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
  console.error("[v0] sandbox route error:", err)
  return NextResponse.json({ error: "Sandbox operation failed" }, { status: 500 })
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    return NextResponse.json(await getSandboxOverview())
  } catch (err) {
    return fail(err)
  }
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await request.json().catch(() => ({}))
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const environment = await configureSandbox(
      { schema: body.schema, connectionRef: body.connectionRef, region: body.region },
      actor,
    )
    return NextResponse.json({ environment })
  } catch (err) {
    return fail(err)
  }
}
