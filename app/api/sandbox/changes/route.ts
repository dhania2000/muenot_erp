import { NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { createChange, getSandboxOverview, SandboxError } from "@/lib/sandbox/service"

/** List configuration change requests / create a new draft change. */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const overview = await getSandboxOverview()
    return NextResponse.json({ changes: overview.changes })
  } catch (err) {
    if (err instanceof SandboxError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    return NextResponse.json({ error: "Failed to list changes" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await request.json().catch(() => ({}))
  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const change = await createChange({ title: body.title, changes: body.changes }, actor)
    return NextResponse.json({ change }, { status: 201 })
  } catch (err) {
    if (err instanceof SandboxError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error("[v0] sandbox create change error:", err)
    return NextResponse.json({ error: "Failed to create change" }, { status: 500 })
  }
}
