import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction } from "@/lib/api-auth"
import { addDocument, deleteDocument, SubscriptionError } from "@/lib/company-subscriptions"

export const runtime = "nodejs"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await requireModuleAction("assets.company_subscriptions", "manage_documents")
  if (!session) return NextResponse.json({ error: "You do not have permission to manage documents." }, { status: 403 })
  const { id } = await ctx.params
  try {
    const body = await req.json().catch(() => ({}))
    const detail = await addDocument(id, body, session)
    return NextResponse.json(detail, { status: 201 })
  } catch (error) {
    if (error instanceof SubscriptionError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] add subscription document failed", (error as Error).message)
    return NextResponse.json({ error: "Failed to add document." }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const session = await requireModuleAction("assets.company_subscriptions", "manage_documents")
  if (!session) return NextResponse.json({ error: "You do not have permission to manage documents." }, { status: 403 })
  const { id } = await ctx.params
  const docId = Number(req.nextUrl.searchParams.get("doc_id"))
  if (!docId) return NextResponse.json({ error: "doc_id is required." }, { status: 400 })
  try {
    const detail = await deleteDocument(id, docId, session)
    return NextResponse.json(detail)
  } catch (error) {
    if (error instanceof SubscriptionError) return NextResponse.json({ error: error.message }, { status: error.status })
    return NextResponse.json({ error: "Failed to remove document." }, { status: 500 })
  }
}
