import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { deleteMigration } from "@/lib/storage/migration-store"
import { logStorageAudit } from "@/lib/storage/connection-store"

export const runtime = "nodejs"

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const id = Number((await params).id)
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const result = await deleteMigration(id)
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 404 })

  await logStorageAudit("migration_removed", { detail: `mapping #${id}`, userId: session.userId })
  return NextResponse.json({ ok: true })
}
