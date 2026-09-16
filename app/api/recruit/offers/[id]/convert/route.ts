import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { convertOfferToEmployee } from "@/lib/recruit-integrations-db"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    const result = await convertOfferToEmployee(id, body || {}, session.userId)
    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Conversion failed" }, { status: 400 })
  }
}
