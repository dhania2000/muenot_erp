import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listTenants } from "@/lib/tenant-service"
import { runArchiveSweep, PLATFORM_SCOPE } from "@/lib/audit-retention"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * SPEC 68 — Phase 2. Automatic audit-log retention lifecycle.
 *
 * Runs unattended via the central scheduler (registered in lib/cron-jobs.ts)
 * authenticated with the shared CRON_SECRET Bearer token, and is also runnable
 * on demand by a signed-in user. Sweeps the platform-wide rows (tenant_id IS
 * NULL) under the platform policy, then every active tenant under its own
 * resolved policy — archiving aged entries into the immutable archive and
 * purging sealed originals only when a policy opts in and no legal hold applies.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function handle(request: Request) {
  if (!authorized(request)) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let archived = 0
  let purged = 0
  let batches = 0
  let heldSkipped = 0
  let scopesFailed = 0
  const errors: string[] = []

  const accumulate = (r: { archived: number; purged: number; batches: number; heldSkipped: number; errors: string[] }) => {
    archived += r.archived
    purged += r.purged
    batches += r.batches
    heldSkipped += r.heldSkipped
    errors.push(...r.errors)
  }

  // Platform-wide rows first.
  try {
    accumulate(await runArchiveSweep(PLATFORM_SCOPE))
  } catch (err) {
    scopesFailed++
    errors.push(`platform: ${(err as Error).message}`)
  }

  // Then each active tenant under its own policy.
  const tenants = (await listTenants()).filter((t) => t.status === "active")
  for (const tenant of tenants) {
    try {
      accumulate(await runArchiveSweep(tenant.id))
    } catch (err) {
      scopesFailed++
      errors.push(`tenant ${tenant.id}: ${(err as Error).message}`)
    }
  }

  return NextResponse.json({
    success: true,
    tenantsProcessed: tenants.length,
    scopesFailed,
    archived,
    batches,
    purged,
    heldSkipped,
    errors: errors.slice(0, 50),
  })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
