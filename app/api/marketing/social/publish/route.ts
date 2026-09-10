import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  getSocialPostById,
  getSocialAccountById,
  updateSocialPostStatus,
  toPublicPost,
} from "@/lib/social-accounts"
import { publishToAccount, type PublishResult } from "@/lib/social-publish"

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  const postId = Number(body?.postId)
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "Invalid post id" }, { status: 400 })
  }

  const postRow = await getSocialPostById(postId)
  if (!postRow) return NextResponse.json({ error: "Post not found" }, { status: 404 })
  const post = toPublicPost(postRow)

  if (!post.accountIds.length) {
    return NextResponse.json({ error: "This post has no target accounts selected." }, { status: 400 })
  }

  await updateSocialPostStatus(postId, "Publishing")

  const results: PublishResult[] = []
  for (const accountId of post.accountIds) {
    const account = await getSocialAccountById(accountId)
    if (!account) {
      results.push({
        accountId,
        platform: "unknown",
        handle: `#${accountId}`,
        ok: false,
        error: "Account no longer connected",
      })
      continue
    }
    const result = await publishToAccount(account, { content: post.content, image: post.image })
    results.push(result)
  }

  const anyOk = results.some((r) => r.ok)
  const allOk = results.every((r) => r.ok)
  const status = allOk ? "Published" : anyOk ? "Published" : "Failed"
  const publishedAt = anyOk ? new Date().toISOString().slice(0, 19).replace("T", " ") : null

  await updateSocialPostStatus(postId, status, { results, publishedAt })

  const updated = await getSocialPostById(postId)
  return NextResponse.json({
    status,
    results,
    post: updated ? toPublicPost(updated) : null,
  })
}
