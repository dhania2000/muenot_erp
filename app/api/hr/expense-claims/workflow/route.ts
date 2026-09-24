import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { transitionClaim, type ClaimAction } from "@/lib/expense-claims"

/**
 * Expense-claim lifecycle endpoint (SPEC 127). Every move — submit, approve,
 * reject, reimburse, cancel, reopen — routes through the single state machine,
 * which enforces legal transitions, approver authority, segregation of duties,
 * the policy gate on submit, and the Finance posting on approval.
 *
 * POST /api/hr/expense-claims/workflow
 *   { id | claim_id, action, reason?, reference? }
 */

const ACTIONS: ClaimAction[] = ["submit", "approve", "reject", "reimburse", "cancel", "reopen"]

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const idOrRef = body.id ?? body.claim_id
  if (idOrRef == null || String(idOrRef).trim() === "") {
    return NextResponse.json({ error: "A claim id or reference is required." }, { status: 400 })
  }

  const action = String(body.action || "") as ClaimAction
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: `Unknown action. Expected one of: ${ACTIONS.join(", ")}.` }, { status: 400 })
  }

  try {
    const claim = await transitionClaim(idOrRef, action, session, {
      reason: body.reason ?? null,
      reference: body.reference ?? null,
    })
    return NextResponse.json({ claim })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
