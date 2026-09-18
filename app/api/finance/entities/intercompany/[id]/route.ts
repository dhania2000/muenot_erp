import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canCreateInModule } from "@/lib/permission-enforce"
import {
  updateIntercompanyStatus,
  deleteIntercompany,
  EntityValidationError,
  EntityNotFoundError,
  type IntercompanyTxn,
} from "@/lib/legal-entities"

/**
 * SPEC 7 — inter-company transaction lifecycle.
 * PATCH  : move the transaction through draft -> posted -> settled / cancelled.
 *          Only posted/settled rows are eliminated on consolidation.
 * DELETE : remove the transaction.
 */
const PERMISSION_KEY = "finance.entities"

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to update inter-company transactions" }, { status: 403 })
  }
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  try {
    await updateIntercompanyStatus(Number(id), body.status as IntercompanyTxn["status"])
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof EntityValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    if (error instanceof EntityNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    throw error
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to delete inter-company transactions" }, { status: 403 })
  }
  const { id } = await ctx.params
  try {
    await deleteIntercompany(Number(id))
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof EntityNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    throw error
  }
}
