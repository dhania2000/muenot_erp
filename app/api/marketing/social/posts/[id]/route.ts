import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  deleteSocialPost,
  getSocialAccountById,
  getSocialPostById,
  toPublicPost,
  updateSocialPost,
} from "@/lib/social-accounts"
import {
  deleteFromAccount,
  editOnAccount,
  type PlatformActionResult,
  type PublishResult,
} from "@/lib/social-publish"

/** Pulls the stored per-account publish results off a post row. */
function publishedResults(post: ReturnType<typeof toPublicPost>): PublishResult[] {
  return Array.isArray(post.results) ? (post.results as PublishResult[]) : []
}

/** Turns a failed/skipped platform action into a human-readable warning line. */
function toWarning(action: PlatformActionResult): string {
  return `${action.handle}: ${action.message ?? "could not be updated"}`
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const postId = Number(id)
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 })
  }

  // Before removing our DB row, take the post down from every platform it was
  // actually published to. Anything the platform API can't remove (e.g. an
  // Instagram post) comes back as a warning the UI surfaces to the user.
  const warnings: string[] = []
  const postRow = await getSocialPostById(postId)
  if (postRow) {
    const post = toPublicPost(postRow)
    for (const result of publishedResults(post)) {
      if (!result.ok) continue // never published to this account — nothing live to remove
      const account = await getSocialAccountById(result.accountId)
      if (!account) continue // account disconnected — can't act, and token is gone
      const action = await deleteFromAccount(account, result.remoteId)
      if (!action.ok) warnings.push(toWarning(action))
    }
  }

  await deleteSocialPost(postId)
  return NextResponse.json({ ok: true, warnings })
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const postId = Number(id)
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 })
  }

  const postRow = await getSocialPostById(postId)
  if (!postRow) return NextResponse.json({ error: "Post not found" }, { status: 404 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.name !== "string" || typeof body.content !== "string") {
    return NextResponse.json({ error: "Name and content are required" }, { status: 400 })
  }
  const name = body.name.trim()
  const content = body.content.trim()
  if (!name || !content) {
    return NextResponse.json({ error: "Name and content are required" }, { status: 400 })
  }

  const existing = toPublicPost(postRow)

  await updateSocialPost(postId, {
    name,
    content,
    brand: typeof body.brand === "string" && body.brand ? body.brand : null,
    imageUrl: typeof body.image === "string" && body.image ? body.image : existing.image ?? null,
    folder: typeof body.folder === "string" && body.folder ? body.folder : existing.folder,
  })

  // If the post is already live, push the new caption to the platforms that
  // allow editing (Facebook). The rest report a warning so the user knows the
  // live post still shows the old text.
  const warnings: string[] = []
  if (postRow.status === "Published") {
    for (const result of publishedResults(existing)) {
      if (!result.ok) continue
      const account = await getSocialAccountById(result.accountId)
      if (!account) continue
      const action = await editOnAccount(account, result.remoteId, { content })
      if (!action.ok) warnings.push(toWarning(action))
    }
  }

  const updated = await getSocialPostById(postId)
  return NextResponse.json({
    ok: true,
    warnings,
    post: updated ? toPublicPost(updated) : null,
  })
}
