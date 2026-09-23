import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantId, currentTenantIdOrNull } from "@/lib/tenant-scope"
import { query } from "@/lib/db"
import { listFileMetadata } from "@/lib/storage"
import { listScans } from "@/lib/storage/file-scanning"

export const runtime = "nodejs"

/**
 * File browsing. Enriches the tenant's centralized file metadata
 * (lib/storage/file-metadata.ts, already real) with owner display names and
 * the scan safety verdict so the Storage → Files table can show one
 * row per file without the client stitching multiple calls together.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const moduleFilter = req.nextUrl.searchParams.get("module") ?? undefined
  try {
    const files = await listFileMetadata({ currentOnly: true, module: moduleFilter, limit: 500 })
    const ownerIds = Array.from(new Set(files.map((f) => f.ownerId).filter((id): id is number => id != null)))
    const nameMap = new Map<number, string>()
    if (ownerIds.length > 0) {
      const placeholders = ownerIds.map(() => "?").join(", ")
      const rows = await query<{ id: number; name: string }[]>(
        `SELECT id, name FROM users WHERE id IN (${placeholders}) AND tenant_id = ?`,
        [...ownerIds, currentTenantId()],
      )
      for (const r of rows) nameMap.set(Number(r.id), String(r.name ?? ""))
    }
    const scans = await listScans({ limit: 500 })
    const scanMap = new Map(scans.map((s) => [s.fileId, s]))

    const rows = files.map((f) => {
      const scan = scanMap.get(f.id)
      return {
        ...f,
        ownerName: f.ownerId != null ? nameMap.get(f.ownerId) ?? null : null,
        scanStatus: scan?.scanStatus ?? "pending",
        safety: scan?.safety ?? "unknown",
        quarantineStatus: scan?.quarantineStatus ?? "not_required",
      }
    })
    return NextResponse.json({ files: rows })
  } catch (err) {
    console.error("[v0] admin file list failed:", err)
    return NextResponse.json({ error: "Could not load files" }, { status: 500 })
  }
}
