import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  updateConnection,
  deleteConnection,
  setActiveConnection,
  deactivateAll,
  logStorageAudit,
  type ConnectionInput,
} from "@/lib/storage/connection-store"
import { isStorageProviderId } from "@/lib/storage/providers"

export const runtime = "nodejs"

async function requireAdmin() {
  const s = await getSession()
  return s && s.role === "admin" ? s : null
}

function parseInput(body: any): ConnectionInput | null {
  if (!body || typeof body !== "object") return null
  if (!isStorageProviderId(String(body.provider))) return null
  return {
    provider: body.provider,
    name: String(body.name ?? ""),
    bucket: String(body.bucket ?? ""),
    region: body.region != null ? String(body.region) : null,
    endpoint: body.endpoint != null ? String(body.endpoint) : null,
    accessKeyId: body.accessKeyId != null ? String(body.accessKeyId) : null,
    secretAccessKey: body.secretAccessKey ? String(body.secretAccessKey) : null,
    forcePathStyle: Boolean(body.forcePathStyle),
    publicBaseUrl: body.publicBaseUrl != null ? String(body.publicBaseUrl) : null,
    pathPrefix: body.pathPrefix != null ? String(body.pathPrefix) : null,
    serverSideEncryption: body.serverSideEncryption != null ? String(body.serverSideEncryption) : null,
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = Number((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const input = parseInput(await req.json().catch(() => null))
  if (!input) return NextResponse.json({ error: "Invalid storage provider or payload" }, { status: 400 })

  const result = await updateConnection(id, input)
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })
  await logStorageAudit("connection_updated", { connectionId: id, userId: session.userId })
  return NextResponse.json({ ok: true })
}

// PATCH toggles the active connection: { action: "activate" | "deactivate" }.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = Number((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? "activate")

  if (action === "deactivate") {
    await deactivateAll()
    await logStorageAudit("connection_deactivated", { connectionId: id, userId: session.userId })
    return NextResponse.json({ ok: true })
  }
  const result = await setActiveConnection(id)
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 404 })
  await logStorageAudit("connection_activated", { connectionId: id, userId: session.userId })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = Number((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const result = await deleteConnection(id)
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 404 })
  await logStorageAudit("connection_deleted", { connectionId: id, userId: session.userId })
  return NextResponse.json({ ok: true })
}
