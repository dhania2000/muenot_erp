import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  createContract,
  getContractAnalytics,
  listContracts,
  ContractError,
  type ListFilters,
} from "@/lib/sales/contract-service"
import { canCreateInModule } from "@/lib/permission-enforce"

export async function GET(request: Request) {
  const session = await requireFeature("sales.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const p = url.searchParams
  const filters: ListFilters = {
    search: p.get("search") || undefined,
    status: p.get("status") || undefined,
    contract_type: p.get("type") || undefined,
    company_id: p.get("company_id") ? Number(p.get("company_id")) : undefined,
    from: p.get("from") || undefined,
    to: p.get("to") || undefined,
    expiringInDays: p.get("expiring") ? Number(p.get("expiring")) : undefined,
    includeArchived: p.get("archived") === "1",
    sort: p.get("sort") || undefined,
    dir: (p.get("dir") as "asc" | "desc") || undefined,
  }

  const [contracts, analytics] = await Promise.all([listContracts(filters), getContractAnalytics()])
  return NextResponse.json({ contracts, analytics })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!(await canCreateInModule(session, "sales.contracts"))) {
    return NextResponse.json({ error: "You do not have permission to add contracts." }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  try {
    const result = await createContract(body, session.userId)
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    if (err instanceof ContractError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: (err as any)?.message || "Unable to create contract" }, { status: 500 })
  }
}
