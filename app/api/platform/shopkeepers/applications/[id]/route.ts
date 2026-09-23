import { NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { ApplicationError, approveApplication, getApplication, rejectApplication, reopenApplication } from "@/lib/shopkeeper-applications"

export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }
function idOf(value: string) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null }
function failure(error: unknown) {
  if (error instanceof ApplicationError) return NextResponse.json({ error: error.message, field: error.field }, { status: error.status })
  return NextResponse.json({ error: "Could not update application." }, { status: 500 })
}
export async function GET(_request: Request, context: Context) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = idOf((await context.params).id)
  if (!id) return NextResponse.json({ error: "Invalid application id." }, { status: 400 })
  try { return NextResponse.json({ application: await getApplication(id) }, { headers: { "Cache-Control": "no-store" } }) }
  catch (error) { return failure(error) }
}
export async function POST(request: Request, context: Context) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = idOf((await context.params).id)
  if (!id) return NextResponse.json({ error: "Invalid application id." }, { status: 400 })
  const body = await request.json().catch(() => null) as { action?: unknown; planCode?: unknown; startTrial?: unknown; reason?: unknown } | null
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  const actor = { userId: guard.ctx.userId, email: guard.session.email }
  try {
    if (body.action === "approve") {
      if (typeof body.planCode !== "string") throw new ApplicationError("Select a Shopkeeper plan.", 400, "planCode")
      return NextResponse.json(await approveApplication(id, body.planCode, body.startTrial === true, actor))
    }
    if (body.action === "reject") return NextResponse.json({ application: await rejectApplication(id, typeof body.reason === "string" ? body.reason : "", actor) })
    if (body.action === "reopen") return NextResponse.json({ application: await reopenApplication(id, actor) })
    return NextResponse.json({ error: "Unknown action." }, { status: 400 })
  } catch (error) { return failure(error) }
}
