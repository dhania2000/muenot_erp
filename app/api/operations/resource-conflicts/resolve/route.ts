import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canPerformAction } from "@/lib/permission-enforce"
import { listResolutions, resolveConflict } from "@/lib/resource-conflicts"
import { ResolutionError, parseResolutionInput } from "@/lib/resource-conflicts-model"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canPerformAction(session, "operations.allocations", "view"))) {
    return NextResponse.json({ error: "You do not have permission to view allocations." }, { status: 403 })
  }
  try {
    return NextResponse.json({ resolutions: await listResolutions() })
  } catch {
    return NextResponse.json({ error: "Failed to load resolution history" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canPerformAction(session, "operations.allocations", "edit"))) {
    return NextResponse.json({ error: "You do not have permission to change allocations." }, { status: 403 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  try {
    const input = parseResolutionInput(body)
    const idem = request.headers.get("idempotency-key") ?? ((body as any)?.idempotency_key ? String((body as any).idempotency_key) : null)
    const { resolution, replayed } = await resolveConflict(session, input, idem)
    return NextResponse.json({ resolution, replayed }, { status: replayed ? 200 : 201 })
  } catch (error) {
    if (error instanceof ResolutionError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] resolve conflict failed:", (error as Error).message)
    return NextResponse.json({ error: "Failed to resolve conflict" }, { status: 500 })
  }
}
