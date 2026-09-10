import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deleteSocialAccount } from "@/lib/social-accounts"

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const accountId = Number(id)
  if (!Number.isInteger(accountId)) {
    return NextResponse.json({ error: "Invalid account id" }, { status: 400 })
  }

  await deleteSocialAccount(accountId)
  return NextResponse.json({ ok: true })
}
