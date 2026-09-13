import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  archiveContract,
  deleteContract,
  getContract,
  getContractEvents,
  getContractSignatures,
  updateContract,
  ContractError,
} from "@/lib/sales/contract-service"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const contractId = Number(id)
  const contract = await getContract(contractId)
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 })

  const [events, signatures] = await Promise.all([
    getContractEvents(contractId),
    getContractSignatures(contractId),
  ])
  return NextResponse.json({ contract, events, signatures })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    await updateContract(Number(id), body, session.userId, body.row_version)
    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof ContractError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: (err as any)?.message || "Unable to update contract" }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const url = new URL(request.url)
  try {
    if (url.searchParams.get("mode") === "archive") {
      await archiveContract(Number(id), session.userId)
    } else {
      await deleteContract(Number(id), session.userId)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof ContractError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: (err as any)?.message || "Unable to delete contract" }, { status: 500 })
  }
}
