import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { forEachActiveTenant } from "@/lib/tenant-scope"
import { runRetentionSweep } from "@/lib/storage/retention"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * SPEC 36 — Phase 2. Automatic storage-retention cleanup.
 *
 * Runs unattended via Vercel Cron (see vercel.json) authenticated with the
 * shared `CRON_SECRET` Bearer token — the same pattern every other cron uses —
 * and is also runnable on demand by a signed-in user. Fans out per active
 * tenant (`forEachActiveTenant`) so one customer's sweep can never read or
 * mutate another's files. Each tenant sweep:
 *   - only proceeds if that tenant has auto-cleanup enabled,
 *   - re-syncs expiry from the current default/module policy,
 *   - deletes bytes + soft-deletes metadata for aged-out files, and
 *   - NEVER deletes anything under legal hold.
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

  let scanned = 0
  let deleted = 0
  let skippedLegalHold = 0
  let failed = 0

  const fanout = await forEachActiveTenant(async () => {
    const r = await runRetentionSweep()
    scanned += r.scanned
    deleted += r.deleted
    skippedLegalHold += r.skippedLegalHold
    failed += r.failed
  })

  return NextResponse.json({
    success: true,
    tenantsProcessed: fanout.processed,
    tenantsFailed: fanout.failed,
    scanned,
    deleted,
    skippedLegalHold,
    failed,
  })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
