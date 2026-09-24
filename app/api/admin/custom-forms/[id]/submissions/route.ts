import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getFormById } from "@/lib/custom-forms/store"
import { listSubmissions } from "@/lib/custom-forms/service"
import { isSubmissionStatus } from "@/lib/custom-forms/model"

export const dynamic = "force-dynamic"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid form id." }, { status: 400 })
  }

  const form = await getFormById(id)
  if (!form) return NextResponse.json({ error: "Form not found." }, { status: 404 })

  const statusParam = new URL(request.url).searchParams.get("status")
  const status = statusParam && isSubmissionStatus(statusParam) ? statusParam : undefined
  const submissions = await listSubmissions(id, status)
  return NextResponse.json({ form, submissions })
}
