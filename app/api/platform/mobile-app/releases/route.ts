import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { createRelease, listReleases } from "@/lib/mobile-app-releases"
import { ReleaseValidationError } from "@/lib/mobile-app-release-core"

export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try { return NextResponse.json({ releases: await listReleases() }, { headers: { "Cache-Control": "no-store" } }) }
  catch { return NextResponse.json({ error: "Unable to load releases." }, { status: 500 }) }
}

export async function POST(request: Request) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const input: unknown = await request.json()
    const release = await createRelease(input, { userId: guard.ctx.userId, email: guard.session.email })
    return NextResponse.json({ release }, { status: 201 })
  } catch (error) {
    if (error instanceof ReleaseValidationError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    return NextResponse.json({ error: "Unable to create release." }, { status: 500 })
  }
}
