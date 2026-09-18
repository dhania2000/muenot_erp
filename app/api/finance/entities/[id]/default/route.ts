import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canActOnRecord } from "@/lib/permission-enforce"
import { getEntity, setDefaultEntity, EntityNotFoundError } from "@/lib/legal-entities"

/**
 * SPEC 7 — promote one legal entity to be the tenant's default (demoting the
 * current default). The default entity is what new documents pre-select.
 */
const PERMISSION_KEY = "finance.entities"

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const entity = await getEntity(Number(id))
  if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 })
  if (!(await canActOnRecord(session, PERMISSION_KEY, "update", entity))) {
    return NextResponse.json({ error: "You do not have permission to change the default entity" }, { status: 403 })
  }

  try {
    await setDefaultEntity(Number(id))
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof EntityNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    throw error
  }
}
