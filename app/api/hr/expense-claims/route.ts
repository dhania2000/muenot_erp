import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  createClaim,
  deleteClaim,
  listClaims,
  listEmployees,
  resolveSessionEmployee,
  updateClaim,
} from "@/lib/expense-claims"

/**
 * Expense Claims CRUD (SPEC 127).
 *   GET    → the caller's claims + the context the form needs (me / employees /
 *            whether the caller can approve).
 *   POST   → create a draft claim.
 *   PATCH  → edit a Draft / Rejected claim.
 *   DELETE → remove a Draft / Rejected / Cancelled claim.
 */

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const canApprove = session.role === "admin"
  const [claims, me, employees] = await Promise.all([
    listClaims(session),
    resolveSessionEmployee(session.userId),
    canApprove ? listEmployees() : Promise.resolve([]),
  ])
  return NextResponse.json({ claims, me, employees, canApprove })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }
  try {
    const claim = await createClaim(body, session)
    return NextResponse.json({ claim })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }
  const id = body.id ?? body.claim_id
  if (id == null) return NextResponse.json({ error: "A claim id is required." }, { status: 400 })
  try {
    const claim = await updateClaim(id, body, session)
    return NextResponse.json({ claim })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = req.nextUrl.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "A claim id is required." }, { status: 400 })
  try {
    await deleteClaim(id, session)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
