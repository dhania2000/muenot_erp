import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { deleteForm, getFormById, setFormStatus } from "@/lib/custom-forms/store"
import { submissionCounts } from "@/lib/custom-forms/service"
import type { FormStatus } from "@/lib/custom-forms/model"

export const dynamic = "force-dynamic"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid form id." }, { status: 400 })

  const form = await getFormById(id)
  if (!form) return NextResponse.json({ error: "Form not found." }, { status: 404 })
  const counts = await submissionCounts(id)
  return NextResponse.json({ form, counts })
}

const VALID_STATUS: FormStatus[] = ["draft", "published", "archived"]

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid form id." }, { status: 400 })

  const body = await request.json().catch(() => null)
  const status = body?.status as string | undefined
  if (!status || !VALID_STATUS.includes(status as FormStatus)) {
    return NextResponse.json({ error: "A valid status is required." }, { status: 400 })
  }

  const result = await setFormStatus(id, status as FormStatus)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid form id." }, { status: 400 })

  const result = await deleteForm(id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 })
  return NextResponse.json({ ok: true })
}
