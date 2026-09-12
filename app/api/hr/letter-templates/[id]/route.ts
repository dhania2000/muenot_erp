import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getTemplate, updateTemplate, deleteTemplate } from "@/lib/hr-letters-templates"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const template = await getTemplate(Number(id))
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 })
  return NextResponse.json({ template })
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const body = await request.json()
  try {
    const template = await updateTemplate(Number(id), body, session.userId, body.changeNote ?? null)
    if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 })
    return NextResponse.json({ template })
  } catch (error: any) {
    if (error?.code === "ER_DUP_ENTRY")
      return NextResponse.json({ error: "A template with this name already exists" }, { status: 409 })
    return NextResponse.json({ error: error?.message || "Failed to update template" }, { status: 400 })
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  await deleteTemplate(Number(id))
  return NextResponse.json({ ok: true })
}
