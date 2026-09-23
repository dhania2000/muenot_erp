import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { editDraft, getRelease } from "@/lib/mobile-app-releases"
import { ReleaseValidationError } from "@/lib/mobile-app-release-core"

export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }
async function releaseId(context: Context) { const id = Number((await context.params).id); return Number.isSafeInteger(id) && id > 0 ? id : null }

export async function GET(_request: Request, context: Context) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = await releaseId(context)
  if (!id) return NextResponse.json({ error: "Invalid release ID." }, { status: 400 })
  try {
    const release = await getRelease(id)
    return release ? NextResponse.json({ release }, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "Release not found." }, { status: 404 })
  } catch { return NextResponse.json({ error: "Unable to load release." }, { status: 500 }) }
}

export async function PATCH(request: Request, context: Context) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = await releaseId(context)
  if (!id) return NextResponse.json({ error: "Invalid release ID." }, { status: 400 })
  try {
    const input: unknown = await request.json()
    const release = await editDraft(id, input, { userId: guard.ctx.userId, email: guard.session.email })
    return NextResponse.json({ release })
  } catch (error) {
    if (error instanceof ReleaseValidationError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    return NextResponse.json({ error: "Unable to edit release." }, { status: 500 })
  }
}
