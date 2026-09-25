import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listMediaAssets } from "@/lib/storage/media"
import { canViewMediaModule } from "./_access"
import type { MediaKind } from "@/lib/storage/cdn"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VALID_KINDS: MediaKind[] = ["video", "audio", "image"]

/**
 * GET /api/storage/media
 * List the current tenant's monitoring/training media assets.
 * Query: module, entityType, entityId, kind (repeatable), limit.
 * Tenant scope is enforced by the storage layer; per-module VIEW permission is
 * enforced here so a user only sees modules they may view.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const module = url.searchParams.get("module") || undefined
  const entityType = url.searchParams.get("entityType") || undefined
  const entityId = url.searchParams.get("entityId") || undefined
  const limitRaw = Number(url.searchParams.get("limit"))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : undefined
  const kinds = url.searchParams
    .getAll("kind")
    .map((k) => k.toLowerCase())
    .filter((k): k is MediaKind => (VALID_KINDS as string[]).includes(k))

  // If a specific module is requested, gate it up front.
  if (module && !(await canViewMediaModule(session, module))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const assets = await listMediaAssets({
    module,
    entityType,
    entityId,
    kinds: kinds.length ? kinds : undefined,
    limit,
  })

  // Drop any asset whose module the caller may not view (when listing across modules).
  const visible: typeof assets = []
  const decided = new Map<string, boolean>()
  for (const a of assets) {
    let allowed = decided.get(a.module)
    if (allowed === undefined) {
      allowed = await canViewMediaModule(session, a.module)
      decided.set(a.module, allowed)
    }
    if (allowed) visible.push(a)
  }

  return NextResponse.json({ assets: visible })
}
