import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  suggestMatchesForTransaction,
  reconcileTransaction,
  unreconcileTransaction,
} from "@/lib/finance-bank-reconciliation"

export const runtime = "nodejs"

// GET  /api/finance/bank-transactions/reconcile?transactionId=BT-2026-000001
//   → scored match suggestions from the unified ledger (read-only).
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const transactionId = req.nextUrl.searchParams.get("transactionId")
  if (!transactionId) return NextResponse.json({ error: "transactionId is required" }, { status: 400 })

  const { transaction, candidates } = await suggestMatchesForTransaction(transactionId)
  if (!transaction) return NextResponse.json({ error: "Bank transaction not found" }, { status: 404 })
  return NextResponse.json({ candidates })
}

// POST /api/finance/bank-transactions/reconcile
//   { transactionId, action: "reconcile" | "unreconcile", recordId?, sourceModule?,
//     sourceTransactionId?, status? }
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const transactionId = typeof body?.transactionId === "string" ? body.transactionId : null
  const action = body?.action === "unreconcile" ? "unreconcile" : "reconcile"
  if (!transactionId) return NextResponse.json({ error: "transactionId is required" }, { status: 400 })

  const actor = { id: session.userId, name: session.name }

  const result =
    action === "unreconcile"
      ? await unreconcileTransaction(transactionId, actor)
      : await reconcileTransaction(
          transactionId,
          {
            recordId: body?.recordId != null ? Number(body.recordId) : null,
            sourceModule: typeof body?.sourceModule === "string" ? body.sourceModule : null,
            sourceTransactionId:
              typeof body?.sourceTransactionId === "string" ? body.sourceTransactionId : null,
            status: body?.status === "Pending" ? "Pending" : "Reconciled",
          },
          actor,
        )

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
  return NextResponse.json(result)
}
