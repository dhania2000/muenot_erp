import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureLeadGenSchema,
  getFormById,
  updateForm,
  setFormStatus,
  FormNotFoundError,
  SubmissionRejectedError,
} from "@/lib/marketing/leadgen-db"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureLeadGenSchema()
  const session = await requireFeature("marketing.lead_generation.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const form = await getFormById(Number(id))
  if (!form) return NextResponse.json({ error: "Form not found" }, { status: 404 })
  return NextResponse.json({ form })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureLeadGenSchema()
  const session = await requireFeature("marketing.lead_generation.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  try {
    await updateForm(Number(id), await request.json(), session.userId)
    const form = await getFormById(Number(id))
    return NextResponse.json({ ok: true, form })
  } catch (error) {
    if (error instanceof FormNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    if (error instanceof SubmissionRejectedError) {
      return NextResponse.json({ error: error.message, fields: error.fields }, { status: error.status })
    }
    console.error("[leadgen] update form failed", error)
    return NextResponse.json({ error: "Unable to update form" }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureLeadGenSchema()
  const session = await requireFeature("marketing.lead_generation.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  try {
    await setFormStatus(Number(id), "Archived", session.userId)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof FormNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 })
    console.error("[leadgen] archive form failed", error)
    return NextResponse.json({ error: "Unable to archive form" }, { status: 500 })
  }
}
