import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureLeadGenSchema, listForms, createForm, SubmissionRejectedError } from "@/lib/marketing/leadgen-db"

export async function GET(request: Request) {
  await ensureLeadGenSchema()
  const session = await requireFeature("marketing.lead_generation.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const forms = await listForms({
    search: (url.searchParams.get("search") || "").trim(),
    status: url.searchParams.get("status") || "",
    includeArchived: url.searchParams.get("includeArchived") === "1",
  })
  return NextResponse.json({ forms })
}

export async function POST(request: Request) {
  await ensureLeadGenSchema()
  const session = await requireFeature("marketing.lead_generation.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const body = await request.json()
    const created = await createForm(body, session.userId)
    return NextResponse.json({ ok: true, ...created }, { status: 201 })
  } catch (error) {
    if (error instanceof SubmissionRejectedError) {
      return NextResponse.json({ error: error.message, fields: error.fields }, { status: error.status })
    }
    console.error("[leadgen] create form failed", error)
    return NextResponse.json({ error: "Unable to create form" }, { status: 500 })
  }
}
