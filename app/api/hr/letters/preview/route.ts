import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { renderLetterTemplate, validateTemplate, missingRequiredValues } from "@/lib/hr-letters-render"
import { buildLetterContext, getTemplateForGeneration } from "@/lib/hr-letters-generate"
import { eventByKey, type LetterSource } from "@/lib/hr-letters-shared"

// Generate-time preview for the letter wizard. Resolves the real employee +
// source record through the shared context builder and renders the merged
// subject/body with the SAME engine the generator uses, so what the user sees
// is exactly what gets persisted. Also reports missing required values so the
// wizard can block generation with a clear message (source-context validation).
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await userHasFeature(session.userId, session.role, "hr.view_letters"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))

  const template = body.template_id ? await getTemplateForGeneration(Number(body.template_id)) : null
  const subjectTpl = body.subject ?? template?.subject ?? ""
  const bodyTpl = body.body ?? template?.body ?? ""
  const eventKey = body.event_key || template?.event_key || "manual"
  const source = (body.source || eventByKey(eventKey).source) as LetterSource

  const context = await buildLetterContext({
    source,
    employeeId: body.employee_id ? Number(body.employee_id) : null,
    sourceRef: body.source_ref ? String(body.source_ref) : null,
    letterNumber: "LTR-PREVIEW",
    issueDate: body.issue_date || new Date().toISOString().slice(0, 10),
    extraVars: body.extra_vars && typeof body.extra_vars === "object" ? body.extra_vars : undefined,
  })

  const validation = validateTemplate({ subject: subjectTpl, body: bodyTpl, eventKey })
  const missing = missingRequiredValues(template?.required_variables, context.vars)

  return NextResponse.json({
    subject: renderLetterTemplate(subjectTpl, context.vars),
    body: renderLetterTemplate(bodyTpl, context.vars),
    recipientName: context.recipientName,
    recipientMeta: context.recipientMeta,
    validation,
    missing,
    variables: context.vars,
  })
}
