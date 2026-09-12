import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listTemplates } from "@/lib/hr-letters-templates"

// Export templates as a portable JSON bundle (re-importable via /import).
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const sp = new URL(request.url).searchParams
  const templates = await listTemplates({
    status: sp.get("status") || undefined,
    category: sp.get("category") || undefined,
  })
  const bundle = {
    kind: "hr-letter-templates",
    version: 1,
    exported_at: new Date().toISOString(),
    templates: templates.map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category,
      letter_type: t.letter_type,
      audience: t.audience,
      event_key: t.event_key,
      subject: t.subject,
      body: t.body,
      status: t.status,
      required_variables: t.required_variables,
    })),
  }
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="letter-templates-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  })
}
