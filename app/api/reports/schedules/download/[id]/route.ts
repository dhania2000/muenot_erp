import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { resolveScheduleDownload } from "@/lib/reports/scheduler-store"

/**
 * SPEC 98 — storage-delivery download.
 *
 * Serves the artifact bytes retained for a storage-channel run behind the HMAC
 * link minted by `buildRunDownloadPath` (see scheduler-store). The signature +
 * expiry are verified in the store; access is additionally scoped to the
 * signed-in tenant admin so links can't be replayed across tenants.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)

  const runId = Math.floor(Number((await params).id))
  if (!Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: "Invalid run id." }, { status: 400 })
  }

  const url = new URL(request.url)
  const exp = Number(url.searchParams.get("exp"))
  const sig = url.searchParams.get("sig") ?? ""

  const result = await resolveScheduleDownload(tenantId, runId, exp, sig)
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.status })
  }

  return new NextResponse(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.fileName.replace(/"/g, "")}"`,
      "Content-Length": String(result.bytes.length),
      "Cache-Control": "private, no-store",
    },
  })
}
