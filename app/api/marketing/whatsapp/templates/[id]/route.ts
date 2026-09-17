import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getLocalTemplate, listTemplateVersions } from "@/lib/whatsapp-templates"

/** Returns a single local template plus its version/status history. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const templateId = Number(id)
  if (!Number.isInteger(templateId) || templateId <= 0) {
    return NextResponse.json({ error: "Invalid template id." }, { status: 400 })
  }

  const template = await getLocalTemplate(templateId)
  if (!template) return NextResponse.json({ error: "Template not found." }, { status: 404 })

  const versions = await listTemplateVersions(templateId)
  return NextResponse.json({ template, versions })
}
