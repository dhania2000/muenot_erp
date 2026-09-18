import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getProviderDefinition, isStorageProviderId } from "@/lib/storage/providers"
import { providerFromConnection } from "@/lib/storage"
import { getResolvedConnectionById, logStorageAudit } from "@/lib/storage/connection-store"
import type { ResolvedConnection } from "@/lib/storage/types"

export const runtime = "nodejs"

/**
 * "Test connection" endpoint. Builds a provider from either the posted config
 * or, when editing, the stored connection (so a blank secret reuses the saved
 * credential) and runs a lightweight health check. Never returns credentials.
 */
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = currentTenantIdOrNull()
  if (!tenantId) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || !isStorageProviderId(String(body.provider))) {
    return NextResponse.json({ ok: false, error: "Unknown storage provider" }, { status: 400 })
  }

  const def = getProviderDefinition(body.provider)!

  // Reuse a stored secret when editing and the client left the field blank.
  let secret: string | null = body.secretAccessKey ? String(body.secretAccessKey) : null
  if (!secret && body.id) {
    const existing = await getResolvedConnectionById(Number(body.id))
    if (existing) secret = existing.secretAccessKey
  }

  const conn: ResolvedConnection = {
    id: Number(body.id) || 0,
    tenantId,
    provider: body.provider,
    name: String(body.name ?? "test"),
    bucket: String(body.bucket ?? ""),
    region: body.region != null ? String(body.region) : def.defaultRegion ?? null,
    endpoint: body.endpoint != null ? String(body.endpoint) : null,
    accessKeyId: body.accessKeyId != null ? String(body.accessKeyId) : null,
    secretAccessKey: secret,
    forcePathStyle: Boolean(body.forcePathStyle ?? def.forcePathStyle),
    publicBaseUrl: body.publicBaseUrl != null ? String(body.publicBaseUrl) : null,
    isActive: false,
  }

  if (conn.provider !== "vercel_blob") {
    if (!conn.bucket) return NextResponse.json({ ok: false, error: "A bucket name is required" }, { status: 400 })
    if (!conn.accessKeyId || !conn.secretAccessKey) {
      return NextResponse.json({ ok: false, error: "Access key and secret are required" }, { status: 400 })
    }
  }

  try {
    const provider = providerFromConnection(conn)
    await provider.healthCheck()
    await logStorageAudit("connection_tested", {
      connectionId: conn.id || null,
      detail: `${conn.provider} ok`,
      userId: session.userId,
    })
    return NextResponse.json({ ok: true, message: "Connection successful" })
  } catch (err: any) {
    const message = err?.name === "CredentialsProviderError" ? "Invalid credentials" : err?.message || "Connection failed"
    await logStorageAudit("connection_test_failed", {
      connectionId: conn.id || null,
      detail: `${conn.provider}: ${String(message).slice(0, 200)}`,
      userId: session.userId,
    })
    return NextResponse.json({ ok: false, error: String(message).slice(0, 300) }, { status: 200 })
  }
}
