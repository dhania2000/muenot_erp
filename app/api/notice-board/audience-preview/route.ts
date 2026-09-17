import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureNoticeSchema, canManage, previewAudience, normalizeAudienceValidated } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// POST /api/notice-board/audience-preview — count/list recipients for the compose form.
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const body = await request.json().catch(() => ({}))
  const toType = body?.to_type === "clients" ? "clients" : "employees"
  if (toType === "clients") return NextResponse.json({ count: 0, sample: [], note: "Client notices are informational only" })

  const audienceType = body?.audience_type ?? "all"
  const config = body?.audience_config ?? {}
  const includeInactive = !!body?.include_inactive

  const err = normalizeAudienceValidated(toType, audienceType, config)
  if (err) return NextResponse.json({ count: 0, sample: [], error: err })

  const { count, sample } = await previewAudience(audienceType, config, includeInactive)
  return NextResponse.json({ count, sample })
}
