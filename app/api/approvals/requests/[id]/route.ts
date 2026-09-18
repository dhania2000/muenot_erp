import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getRequestDetail } from "@/lib/approval-authority"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!getCurrentTenant()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const detail = await getRequestDetail(Number(id))
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(detail)
}
