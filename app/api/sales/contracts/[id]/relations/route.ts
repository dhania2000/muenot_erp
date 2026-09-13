import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getContract, getContractRelations } from "@/lib/sales/contract-service"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const contract = await getContract(Number(id))
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 })

  const relations = await getContractRelations(contract)
  return NextResponse.json(relations)
}
