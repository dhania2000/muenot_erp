import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { DATA_DOMAINS, DATA_SCOPE_KINDS, DATA_SCOPE_KIND_META } from "@/lib/data-scope-model"
import { suggestAssignmentValues } from "@/lib/data-scope-store"

/** Admin + tenant gate shared by the data-scope routes. */
export async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  const tenantId = tenant?.tenantId ?? session.tenantId ?? null
  if (tenantId == null) return null
  return { session, tenantId }
}

/** Catalog: the scopeable domains, the scope kinds and suggested assignments. */
export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const suggestions = await suggestAssignmentValues().catch(() => ({ entities: [], branches: [] }))
  return NextResponse.json({
    domains: DATA_DOMAINS.map((d) => ({ key: d.key, label: d.label })),
    kinds: DATA_SCOPE_KINDS.map((k) => ({ value: k, ...DATA_SCOPE_KIND_META[k] })),
    suggestions,
  })
}
