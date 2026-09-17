import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { addComment, listComments } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const comments = await listComments(Number(id))
  return NextResponse.json({ comments })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    const comments = await addComment(Number(id), String(body.body ?? ""), session.userId)
    return NextResponse.json({ comments })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
