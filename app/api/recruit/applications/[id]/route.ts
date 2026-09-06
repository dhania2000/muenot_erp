import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { updateApplication, updateApplicationStage, deleteApplication } from "@/lib/recruit-db"

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const body = await request.json()
  if (body.stage && Object.keys(body).length === 1) {
    await updateApplicationStage(id, body.stage)
  } else {
    await updateApplication(id, body)
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  await deleteApplication(id)
  return NextResponse.json({ ok: true })
}
