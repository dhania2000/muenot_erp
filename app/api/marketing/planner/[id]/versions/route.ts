import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listVersions } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("marketing.planner.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const versions = await listVersions(Number(id))
  return NextResponse.json({ versions })
}
