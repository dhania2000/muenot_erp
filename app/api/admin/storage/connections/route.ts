import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listConnections, createConnection, logStorageAudit, type ConnectionInput } from "@/lib/storage/connection-store"
import { isStorageProviderId } from "@/lib/storage/providers"

export const runtime = "nodejs"

async function requireAdmin() {
  const s = await getSession()
  return s && s.role === "admin" ? s : null
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const connections = await listConnections()
  return NextResponse.json({ connections })
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
    secretAccessKey: body.secretAccessKey != null ? String(body.secretAccessKey) : null,
    forcePathStyle: Boolean(body.forcePathStyle),
    publicBaseUrl: body.publicBaseUrl != null ? String(body.publicBaseUrl) : null,
    pathPrefix: body.pathPrefix != null ? String(body.pathPrefix) : null,
    serverSideEncryption: body.serverSideEncryption != null ? String(body.serverSideEncryption) : null,
  }
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const input = parseInput(await req.json().catch(() => null))
  if (!input) return NextResponse.json({ error: "Invalid storage provider or payload" }, { status: 400 })

  const result = await createConnection(input, session.userId)
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })

  await logStorageAudit("connection_created", {
    connectionId: result.id,
    detail: `${input.provider} · ${input.bucket || "default"}`,
    userId: session.userId,
  })
  return NextResponse.json({ ok: true, id: result.id })
}
