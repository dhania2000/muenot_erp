import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canCreateInModule } from "@/lib/permission-enforce"
import { listIntercompany, createIntercompany, EntityValidationError } from "@/lib/legal-entities"

/**
 * inter-company transactions (transfers between two of the tenant's
 * own entities). These are eliminated on consolidation so the group is not
 * double-counted.
 * GET  : list transactions (with resolved from/to entity names).
 * POST : create a transaction.
 */
const PERMISSION_KEY = "finance.entities"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const transactions = await listIntercompany()
  return NextResponse.json({ transactions })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to add inter-company transactions" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  try {
    const transaction = await createIntercompany(body, { userId: session.userId, name: session.name })
    return NextResponse.json({ transaction })
  } catch (error) {
    if (error instanceof EntityValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    throw error
  }
}
