import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deleteBankAccount } from "@/lib/legal-entities"

/**
 * delete a single per-entity bank account. Ownership is enforced in
 * the service via requireOwnedRow (IDOR guard) so a foreign id 404s/denies.
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ bankId: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { bankId } = await ctx.params
  await deleteBankAccount(Number(bankId))
  return NextResponse.json({ ok: true })
}
