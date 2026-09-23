import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { commitImport } from "@/lib/data-import-store"

// commit a prepared import. Inserts the valid, non-duplicate rows,
// capturing each new primary key so the batch can be undone, and records an
// immutable import-history job + audit entry. Errors/duplicates are skipped and
// surfaced in the job's downloadable error report.

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const actor = {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  }
  const body = await request.json().catch(() => ({}))
  const datasetKey = String(body?.datasetKey ?? "").trim()
  if (!datasetKey) return NextResponse.json({ error: "A dataset is required" }, { status: 400 })
  try {
    const job = await commitImport(tenantId, actor, {
      datasetKey,
      headers: Array.isArray(body?.headers) ? body.headers : [],
      rows: Array.isArray(body?.rows) ? body.rows : [],
      mapping: body?.mapping && typeof body.mapping === "object" ? body.mapping : undefined,
      fileName: body?.fileName ?? null,
    })
    return NextResponse.json({ job }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
