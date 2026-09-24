import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getFormBySlug } from "@/lib/custom-forms/store"
import { submitForm } from "@/lib/custom-forms/service"

export const dynamic = "force-dynamic"

/**
 * The runtime surface any authenticated tenant user uses to render and submit a
 * published form. Only published forms are exposed; drafts/archived return 404
 * so an unpublished form is never fillable.
 */
async function requireUser() {
  const session = await getSession()
  if (!session) return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session }
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ctx = await requireUser()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { slug } = await params
  const form = await getFormBySlug(slug)
  if (!form || form.status !== "published") {
    return NextResponse.json({ error: "Form not found." }, { status: 404 })
  }
  return NextResponse.json({ form })
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ctx = await requireUser()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { slug } = await params
  const form = await getFormBySlug(slug)
  if (!form || form.status !== "published") {
    return NextResponse.json({ error: "Form not found." }, { status: 404 })
  }

  const body = await request.json().catch(() => null)
  const values = body && typeof body === "object" ? (body.values ?? body) : null
  if (!values || typeof values !== "object") {
    return NextResponse.json({ error: "A values object is required." }, { status: 400 })
  }

  const result = await submitForm(form.id as number, values as Record<string, unknown>, ctx.session.userId)
  if (!result.ok) {
    return NextResponse.json({ error: "Some answers need attention.", errors: result.errors }, { status: 400 })
  }
  return NextResponse.json({ submission: result.submission }, { status: 201 })
}
