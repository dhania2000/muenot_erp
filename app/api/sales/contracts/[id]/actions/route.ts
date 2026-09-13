import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  activateContract,
  amendContract,
  cancelContract,
  countersign,
  renewContract,
  restoreContract,
  sendForSignature,
  signAsClient,
  terminateContract,
  ContractError,
} from "@/lib/sales/contract-service"

/**
 * Single dispatcher for every contract lifecycle transition and workflow.
 * Body: { action: "activate" | "send-signature" | "sign-client" | "countersign" |
 *         "terminate" | "cancel" | "renew" | "amend" | "restore", ... }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_contracts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const contractId = Number(id)
  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")
  const userId = session.userId
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null

  try {
    switch (action) {
      case "activate":
        await activateContract(contractId, userId)
        return NextResponse.json({ success: true })
      case "send-signature":
        await sendForSignature(
          contractId,
          {
            client_name: body.client_name,
            client_email: body.client_email,
            company_name: body.company_name,
            company_email: body.company_email,
          },
          userId,
        )
        return NextResponse.json({ success: true })
      case "sign-client":
        await signAsClient(contractId, body.signer_name, ip, userId)
        return NextResponse.json({ success: true })
      case "countersign":
        await countersign(contractId, body.signer_name, ip, userId)
        return NextResponse.json({ success: true })
      case "terminate":
        await terminateContract(contractId, body.reason, userId)
        return NextResponse.json({ success: true })
      case "cancel":
        await cancelContract(contractId, userId)
        return NextResponse.json({ success: true })
      case "renew":
        return NextResponse.json(
          await renewContract(
            contractId,
            { start_date: body.start_date, end_date: body.end_date, value: body.value },
            userId,
          ),
        )
      case "amend":
        return NextResponse.json(
          await amendContract(
            contractId,
            { value: body.value, end_date: body.end_date, terms: body.terms, notes: body.notes },
            userId,
          ),
        )
      case "restore":
        await restoreContract(contractId, userId)
        return NextResponse.json({ success: true })
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof ContractError) return NextResponse.json({ error: err.message }, { status: err.status })
    return NextResponse.json({ error: (err as any)?.message || "Action failed" }, { status: 500 })
  }
}
