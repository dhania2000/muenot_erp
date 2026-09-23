import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { setReleasePublished } from "@/lib/mobile-app-releases"
import { ReleaseValidationError } from "@/lib/mobile-app-release-core"

export const dynamic = "force-dynamic"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = Number((await context.params).id)
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid release ID." }, { status: 400 })
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { publish?: unknown }).publish !== "boolean") return NextResponse.json({ error: "publish must be a boolean." }, { status: 400 })
    const release = await setReleasePublished(id, (body as { publish: boolean }).publish, { userId: guard.ctx.userId, email: guard.session.email })
    return NextResponse.json({ release })
  } catch (error) {
    if (error instanceof ReleaseValidationError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    return NextResponse.json({ error: "Unable to change publication status." }, { status: 500 })
  }
}
