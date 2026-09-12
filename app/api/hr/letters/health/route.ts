import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { listTemplates } from "@/lib/hr-letters-templates"
import { validateTemplate } from "@/lib/hr-letters-render"

// Template health check: validates every non-archived template's placeholders
// and blocks so admins can catch unknown/malformed variables before a broken
// template is used in production. Active templates with issues are flagged.
export async function GET(_request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await userHasFeature(session.userId, session.role, "hr.view_letters"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const templates = await listTemplates()
  const checked = templates
    .filter((t) => t.status !== "Archived")
    .map((t) => {
      const v = validateTemplate({ subject: t.subject, body: t.body, eventKey: t.event_key })
      const issues = [
        ...v.errors,
        ...(v.unknownVariables.length ? [`Unknown variables: ${v.unknownVariables.join(", ")}`] : []),
      ]
      return {
        id: t.id,
        uid: t.template_uid,
        name: t.name,
        status: t.status,
        event_key: t.event_key,
        healthy: issues.length === 0,
        referenced: v.referenced,
        unknownVariables: v.unknownVariables,
        unbalancedBlocks: v.unbalancedBlocks,
        issues,
      }
    })

  const active = checked.filter((t) => t.status === "Active")
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    summary: {
      total: checked.length,
      active: active.length,
      healthy: checked.filter((t) => t.healthy).length,
      withIssues: checked.filter((t) => !t.healthy).length,
      activeWithIssues: active.filter((t) => !t.healthy).length,
    },
    templates: checked,
  })
}
