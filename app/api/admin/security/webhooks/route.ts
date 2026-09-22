import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { WEBHOOK_EVENTS, createEndpoint, listEndpoints, sanitizeCustomHeaders } from "@/lib/webhooks-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const endpoints = await listEndpoints(ctx.tenantId)
  return NextResponse.json({ endpoints, availableEvents: WEBHOOK_EVENTS })
}

export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as
    | { url?: string; description?: string; events?: string[]; headers?: Record<string, string> }
    | null
  if (!body?.url?.trim()) return NextResponse.json({ error: "Endpoint URL is required" }, { status: 400 })
  try {
    const parsed = new URL(body.url.trim())
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("invalid protocol")
  } catch {
    return NextResponse.json({ error: "Enter a valid URL" }, { status: 400 })
  }
  const validEvents = new Set(WEBHOOK_EVENTS.map((e) => e.value))
  const events = (body.events ?? []).filter((e) => validEvents.has(e as any))
  if (events.length === 0) return NextResponse.json({ error: "Select at least one event" }, { status: 400 })

  const headers = sanitizeCustomHeaders(body.headers ?? {})
  if (headers === null) return NextResponse.json({ error: "Custom headers are invalid" }, { status: 400 })

  const { endpoint, secret } = await createEndpoint(
    ctx.tenantId,
    { url: body.url.trim(), description: body.description ?? null, events, headers },
    ctx.session.userId,
  )
  // The signing secret is returned exactly once — verify it against payload signatures going forward.
  return NextResponse.json({ endpoint, secret })
}
