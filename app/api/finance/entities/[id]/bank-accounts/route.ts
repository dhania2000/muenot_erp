import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canActOnRecord } from "@/lib/permission-enforce"
import {
  getEntity,
  listBankAccounts,
  addBankAccount,
  EntityValidationError,
} from "@/lib/legal-entities"

/**
 * SPEC 7 — per-entity bank / cash identities.
 * GET  : list bank accounts for one entity.
 * POST : add a bank account (optionally marked primary).
 */
const PERMISSION_KEY = "finance.entities"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const accounts = await listBankAccounts(Number(id))
  return NextResponse.json({ accounts })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const entity = await getEntity(Number(id))
  if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 })
  if (!(await canActOnRecord(session, PERMISSION_KEY, "update", entity))) {
    return NextResponse.json({ error: "You do not have permission to edit this entity" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  try {
    const account = await addBankAccount(Number(id), body)
    return NextResponse.json({ account })
  } catch (error) {
    if (error instanceof EntityValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    throw error
  }
}
