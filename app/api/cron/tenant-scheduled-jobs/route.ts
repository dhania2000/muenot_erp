import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { dispatchDueTenantJobs } from "@/lib/tenant-jobs/store"

/**
 * Spec12 (#22-29). Tenant scheduled-jobs dispatcher.
 *
 * Runs unattended every minute via the central scheduler (registered in
 * lib/cron-jobs.ts as `tenant_scheduled_jobs`) authenticated with the shared
 * CRON_SECRET Bearer token, and is also runnable on demand by a signed-in user.
 *
 * One tick locks each due schedule row, consumes its slot exactly once by
 * advancing next_run_at in the same transaction, and enqueues a run into the
 * shared durable queue with a per-tenant concurrency key. It is therefore safe
 * under duplicate/overlapping ticks: a replayed tick sees a future next_run_at
 * (wait) and the unique (schedule_id, slot) run row blocks any double insert.
 * Disabled/suspended tenants get a skipped run and keep advancing.
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
  const result = await dispatchDueTenantJobs()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
