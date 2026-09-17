import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureCallsSchema } from "@/lib/calls-ensure"

export const dynamic = "force-dynamic"

/**
 * POST /api/calls/resolve — batch-resolve loosely-linked identifiers coming from
 * modules OTHER than the HR Employee Master (Operations Resources, Allocations
 * = project members, Tasks = task assignees) into the canonical HR Employee
 * Master id the calling subsystem needs (Phase 60/87-89/93).
 *
 * Operations rows do not carry `hr_employees.id`. A resource carries an
 * `employee_id` (numeric id OR employee code), emails and a display name; an
 * allocation/task carries a `resource_id` pointing at `operations_resources`
 * plus a free-text name. We resolve, in priority order, by: numeric HR id ->
 * employee code -> official/personal email -> exact unique name. Ambiguous name
 * matches (more than one active employee) resolve to null so we never call the
 * wrong person. Rows for vendors/agencies with no HR record simply resolve to
 * null and render no call button.
 *
 * The caller is always the authenticated session; this endpoint only maps
 * public directory identifiers to an employee id and never leaks login user ids.
 */

type Item = {
  key: string
  id?: unknown
  code?: unknown
  email?: unknown
  name?: unknown
  resourceId?: unknown
}

type Resolved = { employeeId: number; name: string; active: boolean; hasLogin: boolean }

const INACTIVE_EMPLOYMENT = new Set(["Resigned", "Terminated", "Ex-Employee", "Suspended"])

const norm = (v: unknown) => (v == null ? "" : String(v).trim())
const numericId = (v: unknown): number | null => {
  const s = norm(v)
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()

  const body = await request.json().catch(() => ({}))
  const rawItems: Item[] = Array.isArray(body.items) ? body.items.slice(0, 300) : []
  if (!rawItems.length) return NextResponse.json({ resolved: {} })

  // Step 1: hydrate any items that only carry a resource_id by looking up the
  // Operations Resource master for its employee link, emails and name.
  const resourceIds = Array.from(
    new Set(rawItems.map((it) => numericId(it.resourceId)).filter((n): n is number => n != null)),
  )
  const resourceMap = new Map<number, { code: string; email: string; email2: string; name: string }>()
  if (resourceIds.length) {
    const rows = await query<any[]>(
      `SELECT id, employee_id, official_email, personal_email, resource_name
         FROM operations_resources
        WHERE id IN (${resourceIds.map(() => "?").join(",")})`,
      resourceIds,
    ).catch(() => [] as any[])
    for (const r of rows) {
      resourceMap.set(Number(r.id), {
        code: norm(r.employee_id),
        email: norm(r.official_email).toLowerCase(),
        email2: norm(r.personal_email).toLowerCase(),
        name: norm(r.resource_name),
      })
    }
  }

  // Effective lookup keys per item (own fields take precedence, resource master fills gaps).
  const items = rawItems.map((it) => {
    const res = numericId(it.resourceId) != null ? resourceMap.get(numericId(it.resourceId)!) : undefined
    const codeRaw = norm(it.code) || res?.code || ""
    return {
      key: String(it.key),
      hrId: numericId(it.id) ?? numericId(it.code),
      code: codeRaw,
      email: (norm(it.email).toLowerCase() || res?.email || "").trim(),
      email2: (res?.email2 || "").trim(),
      name: norm(it.name) || res?.name || "",
    }
  })

  // Step 2: gather distinct candidate values and fetch matching employees at once.
  const ids = new Set<number>()
  const codes = new Set<string>()
  const emails = new Set<string>()
  const names = new Set<string>()
  for (const it of items) {
    if (it.hrId) ids.add(it.hrId)
    if (it.code) codes.add(it.code)
    if (it.email) emails.add(it.email)
    if (it.email2) emails.add(it.email2)
    if (it.name) names.add(it.name)
  }

  const clauses: string[] = []
  const params: unknown[] = []
  if (ids.size) {
    clauses.push(`e.id IN (${[...ids].map(() => "?").join(",")})`)
    params.push(...ids)
  }
  if (codes.size) {
    clauses.push(`e.employee_id IN (${[...codes].map(() => "?").join(",")})`)
    params.push(...codes)
  }
  if (emails.size) {
    const ph = [...emails].map(() => "?").join(",")
    clauses.push(`LOWER(e.official_email) IN (${ph})`)
    params.push(...emails)
    clauses.push(`LOWER(e.personal_email) IN (${ph})`)
    params.push(...emails)
  }
  if (names.size) {
    clauses.push(`e.employee_name IN (${[...names].map(() => "?").join(",")})`)
    params.push(...names)
  }

  const resolved: Record<string, Resolved | null> = {}
  for (const it of items) resolved[it.key] = null
  if (!clauses.length) return NextResponse.json({ resolved })

  const rows = await query<any[]>(
    `SELECT e.id, e.user_id, e.employee_id AS code, e.employee_name AS name,
            LOWER(e.official_email) AS official_email, LOWER(e.personal_email) AS personal_email,
            e.employment_status, e.archived_at, u.status AS login_status
       FROM hr_employees e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE ${clauses.join(" OR ")}`,
    params,
  ).catch(() => [] as any[])

  const toResolved = (r: any): Resolved => {
    const employmentActive =
      !r.archived_at && !INACTIVE_EMPLOYMENT.has(String(r.employment_status || ""))
    const loginActive = !r.login_status || String(r.login_status).toLowerCase() === "active"
    return {
      employeeId: Number(r.id),
      name: r.name || "Employee",
      hasLogin: Boolean(r.user_id),
      active: employmentActive && loginActive && Boolean(r.user_id),
    }
  }

  // Index the fetched rows. Names can collide, so track ambiguity to stay safe.
  const byId = new Map<number, any>()
  const byCode = new Map<string, any>()
  const byEmail = new Map<string, any>()
  const byName = new Map<string, any[]>()
  for (const r of rows) {
    byId.set(Number(r.id), r)
    if (r.code) byCode.set(String(r.code), r)
    if (r.official_email) byEmail.set(String(r.official_email), r)
    if (r.personal_email) byEmail.set(String(r.personal_email), r)
    if (r.name) {
      const list = byName.get(String(r.name)) || []
      list.push(r)
      byName.set(String(r.name), list)
    }
  }

  for (const it of items) {
    let row: any | undefined
    if (it.hrId) row = byId.get(it.hrId)
    if (!row && it.code) row = byCode.get(it.code)
    if (!row && it.email) row = byEmail.get(it.email)
    if (!row && it.email2) row = byEmail.get(it.email2)
    if (!row && it.name) {
      const matches = byName.get(it.name)
      if (matches && matches.length === 1) row = matches[0]
    }
    resolved[it.key] = row ? toResolved(row) : null
  }

  return NextResponse.json({ resolved })
}
