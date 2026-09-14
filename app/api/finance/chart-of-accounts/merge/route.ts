import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { previewMerge, mergeAccounts } from "@/lib/finance-account-merge"

// POST: run the merge. When `preview` is true, only validate and return the
// dependency breakdown so the UI can show the user what will move before they
// confirm. Otherwise execute the merge (repoint live refs, archive source,
// audit both sides).
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const sourceId = String(body.source_account_id ?? "")
  const targetId = String(body.target_account_id ?? "")

  if (body.preview) {
    const preview = await previewMerge(sourceId, targetId)
    return NextResponse.json(preview, { status: preview.ok ? 200 : 400 })
  }

  const result = await mergeAccounts(sourceId, targetId, { userId: session.userId })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result)
}
