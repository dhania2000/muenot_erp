import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { userHasFeature } from "@/lib/permissions"
import { createTemplate, listTemplates } from "@/lib/recruit-email-templates"

/** List Recruitment email templates (with optional search/status/category filters). */
export async function GET(request: NextRequest) {
  const session = await requireFeature("recruitment.email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const [templates, canManage] = await Promise.all([
    listTemplates({
      search: searchParams.get("search") || undefined,
      status: searchParams.get("status") || undefined,
      category: searchParams.get("category") || undefined,
      includeArchived: searchParams.get("includeArchived") === "1",
    }),
    userHasFeature(session.userId, session.role, "recruitment.email_templates"),
  ])
  return NextResponse.json({ templates, canManage })
}

/** Create a new Recruitment email template. */
export async function POST(request: NextRequest) {
  const session = await requireFeature("recruitment.email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const result = await createTemplate(
    {
      name: body.name,
      template_key: body.template_key,
      description: body.description,
      category: body.category,
      audience: body.audience,
      event_key: body.event_key,
      subject: body.subject,
      body: body.body,
      body_text: body.body_text,
      status: body.status,
      attachment: body.attachment,
    },
    session.userId,
  )
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.code })
  return NextResponse.json(result)
}
