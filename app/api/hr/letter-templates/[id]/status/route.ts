import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { transitionTemplate } from "@/lib/hr-letters-templates"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const body = await request.json()
  const to = String(body.status || "").trim()
  if (!to) return NextResponse.json({ error: "Target status is required" }, { status: 400 })
  const result = await transitionTemplate(Number(id), to, session.userId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
  return NextResponse.json({ template: result.template })
}
