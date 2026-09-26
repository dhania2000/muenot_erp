import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { forEachActiveTenant } from "@/lib/tenant-scope"
import { getTenantStorage } from "@/lib/storage"
import {
  expireDueLargeExports,
  listOrphanedQueuedExports,
  processLargeExportJob,
  recoverStaleLargeExports,
} from "@/lib/reports/large-export-store"

/**
 * SPEC 33 (#97). Large-export maintenance sweep, per active tenant:
 *  - fails `running` jobs whose worker died,
 *  - runs `queued` jobs whose `after()` trigger never fired,
 *  - deletes artifacts past their retention and marks them `expired`.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

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

  let recovered = 0
  let processed = 0
  let expired = 0
  const fanout = await forEachActiveTenant(async ({ tenantId }) => {
    const { provider } = await getTenantStorage()
    recovered += await recoverStaleLargeExports(tenantId)
    for (const id of await listOrphanedQueuedExports(tenantId)) {
      await processLargeExportJob(id, { provider, tenantId })
      processed++
    }
    expired += await expireDueLargeExports(tenantId, provider)
  })

  return NextResponse.json({
    success: true,
    tenantsProcessed: fanout.processed,
    tenantsFailed: fanout.failed,
    recovered,
    processed,
    expired,
  })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
