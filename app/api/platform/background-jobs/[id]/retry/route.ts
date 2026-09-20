import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { RetryConflict, retryDeadLetter } from "@/lib/job-manual-retry"
export const dynamic = "force-dynamic"
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = Number((await params).id)
  const body = await request.json().catch(() => null)
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(body?.attempt) || body.attempt < 0)
    return NextResponse.json({ error: "Valid job ID and current attempt are required" }, { status: 400 })
  try {
    return NextResponse.json(await retryDeadLetter(id, body.attempt, guard.session.userId, body.acknowledgeUncertain === true))
  } catch (error) {
    return NextResponse.json({ error: error instanceof RetryConflict ? error.message : "Unable to retry job" }, { status: error instanceof RetryConflict ? 409 : 500 })
  }
}
