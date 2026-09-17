import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { renderTemplate } from "@/lib/email"
import { extractVariables } from "@/lib/recruit-email-templates"

/**
 * Render a subject/body against sample variables so the editor can show a live,
 * fully-substituted preview. Reuses the same `renderTemplate` engine the real
 * send pipeline uses, so what you preview is what recipients receive.
 */
export async function POST(request: NextRequest) {
  const session = await requireFeature("recruitment.email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const subject: string = body.subject || ""
  const html: string = body.body || ""
  const sample: Record<string, string> = body.sample || {}

  const usedVars = extractVariables(subject, html)
  const vars: Record<string, string> = {}
  for (const name of usedVars) {
    vars[name] = sample[name] ?? `{{${name}}}`
  }

  return NextResponse.json({
    subject: renderTemplate(subject, vars),
    body: renderTemplate(html, vars),
    variables: usedVars,
    missing: usedVars.filter((v) => !(v in sample) || sample[v] === ""),
  })
}
