import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getGeneratedContract } from "@/lib/legal-contracts-generate"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const contract = await getGeneratedContract(Number(id))
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 })
  return NextResponse.json({ contract })
}
