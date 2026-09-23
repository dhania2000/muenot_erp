import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import { resolveWidgets, type ResolvedFilters } from "@/lib/dashboards/catalog"

/**
 * Resolve data for a set of widget keys under the current session. Permission
 * is re-checked per widget inside `resolveWidgets`, so a client cannot pull a
 * widget it is not allowed to see even if it POSTs the key directly.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json().catch(() => null)
  const keys: string[] = Array.isArray(body?.keys)
    ? body.keys.filter((k: any) => typeof k === "string").slice(0, 40)
    : []

  const dateRe = /^\d{4}-\d{2}-\d{2}$/
  const f = body?.filters ?? {}
  const filters: ResolvedFilters = {
    from: typeof f.from === "string" && dateRe.test(f.from) ? f.from : null,
    to: typeof f.to === "string" && dateRe.test(f.to) ? f.to : null,
    department: typeof f.department === "string" && f.department.trim() ? f.department.slice(0, 120) : null,
    modules: Array.isArray(f.modules) ? f.modules.filter((m: any) => typeof m === "string") : null,
  }

  const can = await getFeatureChecker(session.userId, session.role)
  const data = await resolveWidgets(keys, {
    userId: session.userId,
    userName: session.name,
    role: session.role,
    filters,
    can,
  })

  return NextResponse.json({ data })
}
