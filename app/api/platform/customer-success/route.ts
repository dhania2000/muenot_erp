import { NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { parseTenantHealthFilter } from "@/lib/customer-success/model"
import { listTenantHealth } from "@/lib/customer-success/store"
import { NO_STORE, csErrorResponse } from "@/lib/customer-success/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Spec31 — platform staff: tenants by health. Filters: band, q (name), plan, risk=1, page, pageSize. */
export async function GET(req: Request) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status, headers: NO_STORE })
  try {
    const filter = parseTenantHealthFilter(new URL(req.url).searchParams)
    const result = await listTenantHealth(filter)
    return NextResponse.json({ ...result, page: filter.page, pageSize: filter.pageSize }, { headers: NO_STORE })
  } catch (err) {
    return csErrorResponse(err, "Failed to list tenant health")
  }
}
