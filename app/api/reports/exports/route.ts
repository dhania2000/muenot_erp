import { NextResponse, after } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getTenantStorage } from "@/lib/storage"
import type { Actor } from "@/lib/reports/store"
import {
  createLargeExportJob,
  listLargeExportJobs,
  getLargeExportDownloadLink,
  processLargeExportJob,
  toLargeExportFormat,
} from "@/lib/reports/large-export-store"

export const runtime = "nodejs"

/**
 * Large-export queue.
 * GET  — list this tenant's export jobs (with a fresh signed link when ready).
 * POST — queue a new export from a saved report id or an ad-hoc definition;
 *        the artifact is streamed to private storage by a background worker.
 */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { provider } = await getTenantStorage()
  const jobs = await listLargeExportJobs(tenantId, provider)
  const withLinks = await Promise.all(
    jobs.map(async (j) => ({
      ...j,
      downloadPath: j.status === "completed" ? await getLargeExportDownloadLink(tenantId, j.id) : null,
    })),
  )
  return NextResponse.json({ jobs: withLinks })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 })

  const actor: Actor = {
    userId: guard.ctx.userId,
    role: guard.ctx.tenantRole,
    name: guard.session.name,
    email: guard.session.email,
  }

  try {
    const job = await createLargeExportJob(
      tenantId,
      {
        reportId: body.reportId != null ? Number(body.reportId) : null,
        definition: body.definition ?? null,
        name: body.name ?? null,
        format: toLargeExportFormat(body.format),
        requestKey: body.requestKey ?? null,
      },
      actor,
    )

    // Only kick off a worker for a freshly-queued job. A duplicate (idempotent)
    // request returns the existing job and must not re-run it.
    if (job.status === "queued") {
      const { provider } = await getTenantStorage()
      after(async () => {
        try {
          await processLargeExportJob(job.id, { provider, tenantId, actor })
        } catch (err) {
          console.error("[v0] background export worker crashed:", err)
        }
      })
    }

    return NextResponse.json({ job }, { status: 202 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not queue the export."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
