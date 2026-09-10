import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deleteSocialPost } from "@/lib/social-accounts"

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const postId = Number(id)
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 })
  }

  await deleteSocialPost(postId)
  return NextResponse.json({ ok: true })
}
