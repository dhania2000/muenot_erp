import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getContractEvents } from "@/lib/legal-contracts-audit"
import { getContractChain } from "@/lib/legal-contracts-lifecycle"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const [events, chain] = await Promise.all([
    getContractEvents("contract", Number(id)),
    getContractChain(Number(id)),
  ])
  return NextResponse.json({ events, chain })
}
