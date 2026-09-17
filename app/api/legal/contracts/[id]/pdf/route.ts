import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getGeneratedContract, contractPdfContext } from "@/lib/legal-contracts-generate"
import { contractPdfBuffer } from "@/lib/legal-contract-pdf"
import { logContractEvent } from "@/lib/legal-contracts-audit"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.view_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const contract = await getGeneratedContract(Number(id))
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 })

  const ctx = await contractPdfContext(contract)
  const buffer = contractPdfBuffer({
    contractUid: contract.contract_uid,
    referenceNo: contract.reference_no,
    title: contract.title,
    contractType: contract.contract_type,
    body: contract.content,
    effectiveDate: ctx.effectiveDate,
    company: ctx.company,
    firstParty: ctx.firstParty,
    secondParty: ctx.secondParty,
  })

  const download = request.nextUrl.searchParams.get("download") === "1"
  if (download) {
    // Phase 75 — track authorized contract downloads.
    void logContractEvent({
      entity: "contract",
      entityId: contract.id,
      entityRef: contract.reference_no || contract.contract_uid,
      type: "contract_downloaded",
      summary: "Downloaded PDF",
      actorId: session.userId,
      actorName: session.name ?? null,
    })
  }
  const filename = `${contract.reference_no?.replace(/[/\\]/g, "-") || contract.contract_uid}.pdf`
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
    },
  })
}
