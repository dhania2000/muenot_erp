import { NextResponse } from "next/server"
import {
  canManageShared,
  createView,
  listViews,
  normalizeIdempotencyKey,
  SavedViewError,
} from "@/lib/saved-views/store"
import { assertTableAccess, resolveViewer, validateViewName } from "@/lib/saved-views/guard"
import { ROLE_KEYS, ROLE_KEY_LABELS, VIEW_VISIBILITIES } from "@/lib/saved-views/types"
import type { SavedViewsBootstrap, ViewVisibility } from "@/lib/saved-views/types"
import { sanitizeViewConfig } from "@/lib/saved-views/sanitize"
import { captureAuditContext, recordAuditLog } from "@/lib/audit-log-store"

function errorResponse(err: unknown, fallback: string) {
  if (err instanceof SavedViewError) return NextResponse.json({ error: err.message }, { status: err.status })
  console.log("[v0] saved-view request failed:", (err as Error)?.message)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

export async function GET(request: Request) {
  try {
    const viewer = await resolveViewer()
    if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const raw = new URL(request.url).searchParams.get("table")?.trim()
    if (!raw) return NextResponse.json({ error: "A table key is required" }, { status: 400 })
    const tableKey = await assertTableAccess(viewer, raw)

    const views = await listViews(viewer, tableKey)
    const payload: SavedViewsBootstrap = {
      views,
      permissions: { canManageShared: canManageShared(viewer) },
      roles: ROLE_KEYS.map((key) => ({ key, label: ROLE_KEY_LABELS[key] ?? key })),
      teams: Array.from(viewer.teamKeys),
    }
    return NextResponse.json(payload)
  } catch (err) {
    return errorResponse(err, "Failed to load views")
  }
}

export async function POST(request: Request) {
  try {
    const viewer = await resolveViewer()
    if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    if (body.visibility != null && !VIEW_VISIBILITIES.includes(body.visibility)) {
      return NextResponse.json({ error: "Invalid visibility" }, { status: 400 })
    }
    const visibility: ViewVisibility = body.visibility ?? "private"
    const tableKey = await assertTableAccess(viewer, body.tableKey, visibility)
    const name = validateViewName(body.name)
    const idempotencyKey = normalizeIdempotencyKey(request.headers.get("idempotency-key"))
    const config = sanitizeViewConfig(body.config)

    const { id, replayed } = await createView(
      viewer,
      {
        tableKey,
        name,
        visibility,
        roleKey: typeof body.roleKey === "string" ? body.roleKey : null,
        teamKey: typeof body.teamKey === "string" ? body.teamKey : null,
        config,
        isDefault: Boolean(body.isDefault),
      },
      { idempotencyKey },
    )
    if (!replayed) {
      const ctx = await captureAuditContext(request).catch(() => undefined)
      await recordAuditLog(
        {
          action: "saved_view.create",
          entityType: "saved_view",
          entityId: id,
          entityLabel: name,
          after: { tableKey, name, visibility, isDefault: Boolean(body.isDefault) },
        },
        ctx,
      )
    }
    return NextResponse.json({ id, replayed }, { status: replayed ? 200 : 201 })
  } catch (err) {
    return errorResponse(err, "Failed to create view")
  }
}
