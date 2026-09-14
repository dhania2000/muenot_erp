import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  INVOICE_WORKFLOW_MODULES,
  performWorkflowAction,
  type WorkflowAction,
} from "@/lib/finance-invoice-workflow"

export const runtime = "nodejs"

const VALID_ACTIONS: WorkflowAction[] = [
  "employee_approve",
  "employee_reject",
  "manager_approve",
  "manager_reject",
]

// Two-stage approval transitions for invoice workflow modules. The engine
// re-checks the caller's rights against the row's current stage, so this route
// only validates shape and delegates the authorization + state change.
export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { key } = await ctx.params
  if (!INVOICE_WORKFLOW_MODULES.has(key)) {
    return NextResponse.json({ error: "Module has no approval workflow" }, { status: 404 })
  }

  const body = await req.json().catch(() => ({}))
  const id = Number(body?.id)
  const action = body?.action as WorkflowAction
  const reason = typeof body?.reason === "string" ? body.reason : null

  if (!id) return NextResponse.json({ error: "Invoice id is required" }, { status: 400 })
  if (!VALID_ACTIONS.includes(action)) {
    return NextResponse.json({ error: "Invalid workflow action" }, { status: 400 })
  }

  const result = await performWorkflowAction(key, id, action, reason, session)
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.code })
  }
  return NextResponse.json(result)
}
