import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { WEBHOOK_EVENTS, deleteEndpoint, sanitizeCustomHeaders, updateEndpoint } from "@/lib/webhooks-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = (await request.json().catch(() => null)) as
    | {
        url?: string
        description?: string | null
        events?: string[]
        status?: "active" | "disabled"
        headers?: Record<string, string>
      }
    | null
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 })

  const validEvents = new Set(WEBHOOK_EVENTS.map((e) => e.value))
  const events = body.events ? body.events.filter((e) => validEvents.has(e as any)) : undefined

  let headers: Record<string, string> | undefined
  if (body.headers !== undefined) {
    const clean = sanitizeCustomHeaders(body.headers)
    if (clean === null) return NextResponse.json({ error: "Custom headers are invalid" }, { status: 400 })
    headers = clean
  }

  await updateEndpoint(ctx.tenantId, Number(id), {
    url: body.url,
    description: body.description,
    events,
    status: body.status,
    headers,
  })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  await deleteEndpoint(ctx.tenantId, Number(id))
  return NextResponse.json({ ok: true })
}
