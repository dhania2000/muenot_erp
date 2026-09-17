import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureLeadGenSchema,
  setFormStatus,
  duplicateForm,
  FormNotFoundError,
  type FormStatus,
} from "@/lib/marketing/leadgen-db"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureLeadGenSchema()
  const session = await requireFeature("marketing.lead_generation.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")

  try {
    const statusMap: Record<string, FormStatus> = {
      publish: "Published",
      pause: "Paused",
      unpublish: "Draft",
      archive: "Archived",
    }
    if (action === "duplicate") {
      const created = await duplicateForm(Number(id), session.userId)
      return NextResponse.json({ ok: true, ...created })
    }
    if (statusMap[action]) {
      await setFormStatus(Number(id), statusMap[action], session.userId)
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (error) {
    if (error instanceof FormNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    console.error("[leadgen] form action failed", error)
    return NextResponse.json({ error: "Unable to perform action" }, { status: 500 })
  }
}
