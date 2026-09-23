import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getExportJobWithLink } from "@/lib/data-export-store"

// single export job (poll status + obtain a fresh signed link).

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const job = await getExportJobWithLink(tenantId, Number(id))
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ job })
}
