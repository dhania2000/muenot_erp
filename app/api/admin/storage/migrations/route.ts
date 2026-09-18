import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { listMigrations, createMigration } from "@/lib/storage/migration-store"
import { migrationLabels } from "@/lib/storage/migration-catalog"
import { logStorageAudit } from "@/lib/storage/connection-store"

export const runtime = "nodejs"

async function requireAdmin() {
  const s = await getSession()
  return s && s.role === "admin" ? s : null
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })
  const mappings = await listMigrations()
  return NextResponse.json({ mappings })
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  const moduleKey = String(body.moduleKey ?? "")
  const subModuleKey = String(body.subModuleKey ?? "")
  const labels = migrationLabels(moduleKey, subModuleKey)
  if (!labels) return NextResponse.json({ error: "Unknown module or sub-module" }, { status: 400 })

  const connectionId =
    body.connectionId != null && body.connectionId !== "" ? Number(body.connectionId) : null
  if (connectionId != null && !Number.isFinite(connectionId)) {
    return NextResponse.json({ error: "Invalid storage connection" }, { status: 400 })
  }

  const result = await createMigration(
    {
      moduleKey,
      moduleLabel: labels.module,
      subModuleKey,
      subModuleLabel: labels.subModule,
      connectionId,
      folder: String(body.folder ?? ""),
    },
    session.userId,
  )
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 })

  await logStorageAudit("migration_mapped", {
    connectionId,
    detail: `${labels.module} · ${labels.subModule} → ${String(body.folder ?? "").slice(0, 200)}`,
    userId: session.userId,
  })
  return NextResponse.json({ ok: true, id: result.id })
}
