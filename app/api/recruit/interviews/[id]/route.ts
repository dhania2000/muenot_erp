import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { updateInterview, deleteInterview } from "@/lib/recruit-db"

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const body = await request.json()
  await updateInterview(id, body)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  await deleteInterview(id)
  return NextResponse.json({ ok: true })
}
