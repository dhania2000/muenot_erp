import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { listRecycleEntries } from "@/lib/recycle-bin/store"
import { isRecycleEntryStatus, type RecycleEntryStatus } from "@/lib/recycle-bin/model"

/**
 * SPEC 35 — Recycle bin listing. Tenant-admin only and always scoped to the
 * caller's effective tenant, so one tenant can never enumerate another's
 * soft-deleted records.
 */
export async function GET(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const url = new URL(request.url)
  const statusParam = url.searchParams.get("status")
  const status: RecycleEntryStatus | undefined =
    statusParam && isRecycleEntryStatus(statusParam) ? statusParam : "recycled"

  try {
    const entries = await listRecycleEntries(tenantId, {
      status,
      entityType: url.searchParams.get("entityType") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      limit: Number(url.searchParams.get("limit")) || undefined,
      offset: Number(url.searchParams.get("offset")) || undefined,
    })
    return NextResponse.json({ entries })
  } catch (err) {
    console.error("[v0] recycle-bin list error:", err)
    return NextResponse.json({ error: "Failed to load recycle bin" }, { status: 500 })
  }
}
