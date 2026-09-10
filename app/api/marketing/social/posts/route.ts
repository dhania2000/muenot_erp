import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  createSocialPost,
  listSocialPosts,
  toPublicPost,
  type SocialPlatform,
} from "@/lib/social-accounts"
import { SOCIAL_PLATFORMS } from "@/lib/social-platforms"

const VALID_PLATFORMS = new Set(SOCIAL_PLATFORMS.map((p) => p.id))

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const rows = await listSocialPosts()
  return NextResponse.json({ posts: rows.map(toPublicPost) })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.name !== "string" || typeof body.content !== "string") {
    return NextResponse.json({ error: "Name and content are required" }, { status: 400 })
  }

  const name = body.name.trim()
  const content = body.content.trim()
  if (!name || !content) {
    return NextResponse.json({ error: "Name and content are required" }, { status: 400 })
  }

  const targets: SocialPlatform[] = Array.isArray(body.targets)
    ? body.targets.filter((t: string) => VALID_PLATFORMS.has(t as SocialPlatform))
    : []
  const accountIds: number[] = Array.isArray(body.accountIds)
    ? body.accountIds.map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n))
    : []

  const status = body.status === "Publishing" ? "Publishing" : "Draft"

  const id = await createSocialPost({
    name,
    content,
    brand: typeof body.brand === "string" && body.brand ? body.brand : null,
    imageUrl: typeof body.image === "string" && body.image ? body.image : null,
    targets,
    accountIds,
    status,
    folder: typeof body.folder === "string" && body.folder ? body.folder : "Unclassified",
    createdByUserId: session.userId,
  })

  return NextResponse.json({ id })
}
