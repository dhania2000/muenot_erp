import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { transitionExpense, type ExpenseWorkflowAction } from "@/lib/finance-expense-workflow"

/**
 * Expense approval workflow endpoint. Every lifecycle move — submit, approve,
 * reject, cancel, reopen — routes through the single state machine in
 * finance-expense-workflow, which enforces legal transitions, amount-tiered
 * approval authority, segregation of duties, period locks, auto-posting on
 * approval, and the audit trail. This route only authenticates and delegates.
 *
 * POST /api/finance/expenses/workflow
 *   { expense: number | "EXP-...", action, reason?, override? }
 */

const ACTIONS: ExpenseWorkflowAction[] = ["submit", "approve", "reject", "cancel", "reopen"]

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const idOrRef = body.expense ?? body.expense_id ?? body.id
  if (idOrRef == null || String(idOrRef).trim() === "") {
    return NextResponse.json({ error: "An expense id or reference is required." }, { status: 400 })
  }

  const action = String(body.action || "") as ExpenseWorkflowAction
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: `Unknown action. Expected one of: ${ACTIONS.join(", ")}.` }, { status: 400 })
  }

  // Only admins may override segregation of duties or reopen; the state machine
  // makes the final authority call per amount tier.
  const override = Boolean(body.override) && session.role === "admin"

  try {
    const result = await transitionExpense(idOrRef, action, {
      actorId: session.userId,
      actorRole: session.role,
      reason: body.reason ?? null,
      override,
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
