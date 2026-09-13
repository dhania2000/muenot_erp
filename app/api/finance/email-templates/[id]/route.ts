import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listVersions,
  updateTemplate,
} from "@/lib/finance-email-templates"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("finance.email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const template = await getTemplate(Number(id))
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 })
  const versions = await listVersions(Number(id))
  return NextResponse.json({ template, versions })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("finance.email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))

  if (body.action === "duplicate") {
    const result = await duplicateTemplate(Number(id), session.userId)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
    return NextResponse.json(result)
  }

  const current = await getTemplate(Number(id))
  if (!current) return NextResponse.json({ error: "Template not found" }, { status: 404 })

  const result = await updateTemplate(
    Number(id),
    {
      name: body.name ?? current.name,
      template_key: "template_key" in body ? body.template_key : current.template_key,
      description: "description" in body ? body.description : current.description,
      category: body.category ?? current.category,
      audience: body.audience ?? current.audience,
      subject: body.subject ?? current.subject,
      body: body.body ?? current.body,
      body_text: "body_text" in body ? body.body_text : current.body_text,
      status: body.status ?? current.status,
      attachment:
        "attachment" in body
          ? body.attachment
          : current.attachment_pathname
            ? {
                pathname: current.attachment_pathname,
                filename: current.attachment_name,
                contentType: current.attachment_type,
                size: current.attachment_size,
              }
            : null,
    },
    session.userId,
  )
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
  return NextResponse.json(result)
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("finance.email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const { searchParams } = new URL(request.url)
  const result = await deleteTemplate(Number(id), { hard: searchParams.get("hard") === "1" })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
  return NextResponse.json(result)
}
