import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { renderLetterTemplate, validateTemplate } from "@/lib/hr-letters-render"
import { buildLetterContext } from "@/lib/hr-letters-generate"
import { eventByKey, variablesForEvent, type LetterSource } from "@/lib/hr-letters-shared"

// Server-side preview + validation for the template editor. Renders against a
// real employee/source record when provided, otherwise against example values
// from the variable catalog so the author always sees a filled letter.
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json()
  const subject = String(body.subject || "")
  const content = String(body.body || "")
  const eventKey = String(body.event_key || "manual")
  const source = eventByKey(eventKey).source as LetterSource

  const validation = validateTemplate({ subject, body: content, eventKey })

  let vars: Record<string, string> = {}
  if (body.employeeId || body.sourceRef) {
    const ctx = await buildLetterContext({
      source,
      employeeId: body.employeeId ? Number(body.employeeId) : null,
      sourceRef: body.sourceRef ? String(body.sourceRef) : null,
      letterNumber: "LTR-PREVIEW",
      issueDate: new Date().toISOString().slice(0, 10),
      extraVars: body.extraVars || {},
    })
    vars = ctx.vars
  } else {
    // Example values so an unbound preview is still readable.
    for (const v of variablesForEvent(eventKey)) vars[v.token] = v.example || `[${v.label}]`
    vars.letter_number = "LTR-PREVIEW"
    Object.assign(vars, body.extraVars || {})
  }

  return NextResponse.json({
    subject: renderLetterTemplate(subject, vars),
    body: renderLetterTemplate(content, vars),
    validation,
    variables: vars,
  })
}
