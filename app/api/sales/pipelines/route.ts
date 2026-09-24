import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listPipelines, createPipeline, getDealMeta, DealValidationError } from "@/lib/sales/deal-pipeline"

export async function GET() {
  const session = await requireFeature("sales.view_deals")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const [pipelines, meta] = await Promise.all([listPipelines(), getDealMeta()])
  return NextResponse.json({ pipelines, ...meta })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_deals")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const body = await request.json()
    const created = await createPipeline(body, session.userId)
    return NextResponse.json(created)
  } catch (error) {
    if (error instanceof DealValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    console.error("[pipelines] create failed", error)
    return NextResponse.json({ error: "Unable to create pipeline." }, { status: 500 })
  }
}
