import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { createTemplate, updateTemplate, listTemplates } from "@/lib/hr-letters-templates"

// Import a template bundle produced by /export. Existing templates (matched by
// name) are updated; new ones are created. Imported templates land as Draft
// unless the bundle says otherwise.
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let payload: any
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const items: any[] = Array.isArray(payload) ? payload : payload?.templates
  if (!Array.isArray(items) || !items.length) {
    return NextResponse.json({ error: "No templates found in payload" }, { status: 400 })
  }

  const existing = await listTemplates()
  const byName = new Map(existing.map((t) => [t.name.trim().toLowerCase(), t]))

  const results = { created: 0, updated: 0, skipped: 0, errors: [] as string[] }
  for (const raw of items) {
    const name = String(raw?.name || "").trim()
    if (!name || !raw?.subject || !raw?.body) {
      results.skipped++
      continue
    }
    const input = {
      name,
      description: raw.description ?? null,
      category: raw.category || "General",
      letter_type: raw.letter_type || "Other",
      audience: raw.audience || "Employee",
      event_key: raw.event_key || "manual",
      subject: raw.subject,
      body: raw.body,
      status: raw.status || "Draft",
      required_variables: Array.isArray(raw.required_variables) ? raw.required_variables : null,
    }
    try {
      const match = byName.get(name.toLowerCase())
      if (match) {
        await updateTemplate(match.id, input, session.userId, "Imported")
        results.updated++
      } else {
        await createTemplate(input, session.userId)
        results.created++
      }
    } catch (error: any) {
      results.errors.push(`${name}: ${error?.message || "failed"}`)
    }
  }
  return NextResponse.json(results)
}
