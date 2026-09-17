import { NextRequest, NextResponse } from "next/server"
import { listProductAudit } from "@/lib/products-audit"
import { getProductSession } from "@/lib/products-api-auth"

export const runtime = "nodejs"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const audit = await listProductAudit(Number(id))
  return NextResponse.json({ audit })
}
