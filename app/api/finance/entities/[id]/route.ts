import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canActOnRecord } from "@/lib/permission-enforce"
import {
  getEntity,
  updateEntity,
  deleteEntity,
  EntityValidationError,
  EntityNotFoundError,
} from "@/lib/legal-entities"

/**
 * SPEC 7 — Legal entity detail.
 * GET    : fetch one entity.
 * PATCH  : update fields (name, tax identity, address, book, default flag…).
 * DELETE : remove an entity (blocked while it still owns posted ledger rows).
 * Update/Delete honour the finance.entities record scope.
 */
const PERMISSION_KEY = "finance.entities"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const entity = await getEntity(Number(id))
  if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 })
  return NextResponse.json({ entity })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const updated = await updateEntity(Number(id), body, { userId: session.userId, name: session.name })
    return NextResponse.json({ entity: updated })
  } catch (error) {
    if (error instanceof EntityValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    if (error instanceof EntityNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    throw error
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const entity = await getEntity(Number(id))
  if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 })
  if (!(await canActOnRecord(session, PERMISSION_KEY, "delete", entity))) {
    return NextResponse.json({ error: "You do not have permission to delete this entity" }, { status: 403 })
  }

  try {
    await deleteEntity(Number(id))
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof EntityValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    if (error instanceof EntityNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    throw error
  }
}
