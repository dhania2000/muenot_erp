import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listTenants } from "@/lib/tenant-service"
import { runTenantSweep } from "@/lib/retention-engine"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Phase 4. Automatic data-retention lifecycle.
 *
 * Runs unattended via the central scheduler (registered in lib/cron-jobs.ts)
 * authenticated with the shared CRON_SECRET Bearer token, and is also runnable
 * on demand by a signed-in user. Sweeps every active tenant's runnable
 * retention policies: policies that are paused, under a legal hold, whose
 * target table/columns are missing, or whose delete is blocked by data
 * classification are skipped; the rest archive or delete records past
 * their retention window and record an immutable run + audit entry.
 *
 * The sweep is strictly tenant-scoped (runTenantSweep filters every hot-table
 * predicate by tenant_id), so a run can never touch another tenant's data.
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

  let policies = 0
  let ran = 0
  let skipped = 0
  let failed = 0
  let archived = 0
  let deleted = 0
  let tenantsFailed = 0
  const errors: string[] = []

  const tenants = (await listTenants()).filter((t) => t.status === "active")
  for (const tenant of tenants) {
    try {
      const r = await runTenantSweep(tenant.id)
      policies += r.policies
      ran += r.ran
      skipped += r.skipped
      failed += r.failed
      archived += r.archived
      deleted += r.deleted
      errors.push(...r.errors.map((e) => `tenant ${tenant.id}: ${e}`))
    } catch (err) {
      tenantsFailed++
      errors.push(`tenant ${tenant.id}: ${(err as Error).message}`)
    }
  }

  return NextResponse.json({
    success: true,
    tenantsProcessed: tenants.length,
    tenantsFailed,
    policies,
    ran,
    skipped,
    failed,
    archived,
    deleted,
    errors: errors.slice(0, 50),
  })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
