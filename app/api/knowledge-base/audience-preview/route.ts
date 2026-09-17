import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  ensureKbSchema, canManage, previewAudience, parseAudienceConfig,
  AUDIENCE_TYPES, type AudienceType,
} from "@/lib/knowledge-base"

export const dynamic = "force-dynamic"

// POST /api/knowledge-base/audience-preview — count + sample recipients.
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const body = await request.json()
  const audienceType: AudienceType = AUDIENCE_TYPES.includes(body.audience_type) ? body.audience_type : "all"
  const cfg = parseAudienceConfig(body.audience_config)
  const result = await previewAudience(audienceType, cfg)
  return NextResponse.json(result)
}
