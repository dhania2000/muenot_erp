import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listRules, createRule, type RuleInput } from "@/lib/approval-authority"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return session
}

export async function GET() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const rules = await listRules()
  return NextResponse.json({ rules })
}

export async function POST(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as RuleInput | null
  if (!body?.name?.trim()) return NextResponse.json({ error: "Rule name is required" }, { status: 400 })
  if (!Array.isArray(body.levels) || body.levels.length === 0)
    return NextResponse.json({ error: "At least one approval level is required" }, { status: 400 })

  const id = await createRule(body, session.userId)
  return NextResponse.json({ id }, { status: 201 })
}
