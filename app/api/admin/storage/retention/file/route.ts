import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { setFileRetention, clearFileRetentionOverride } from "@/lib/storage/retention"
import { setLegalHold, getFileById } from "@/lib/storage/file-metadata"
import { logStorageAudit } from "@/lib/storage/connection-store"
import { isRetentionUnit } from "@/lib/storage/retention-policy"

export const runtime = "nodejs"

/**
 * SPEC 36 — Phase 3. Per-file manual retention override + legal hold.
 *   POST { fileId, action: "hold" }               → place on legal hold (never deleted).
 *   POST { fileId, action: "release" }            → release the legal hold.
 *   POST { fileId, action: "override", rule }     → manually pin retention.
 *   POST { fileId, action: "override", expiresAt} → manually pin an explicit date/null.
 *   POST { fileId, action: "clear-override" }     → revert to module/default policy.
 */
async function requireAdmin() {
  const s = await getSession()
  return s && s.role === "admin" ? s : null
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!currentTenantIdOrNull()) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  const fileId = Number(body.fileId)
  if (!Number.isFinite(fileId)) return NextResponse.json({ error: "Invalid fileId" }, { status: 400 })
  const action = String(body.action ?? "")

  const existing = await getFileById(fileId)
  if (!existing) return NextResponse.json({ error: "File not found" }, { status: 404 })

  try {
    if (action === "hold" || action === "release") {
      const hold = action === "hold"
      await setLegalHold(fileId, hold)
      await logStorageAudit(hold ? "legal_hold_placed" : "legal_hold_released", {
        detail: existing.objectKey,
        userId: session.userId,
      })
      return NextResponse.json({ ok: true, file: await getFileById(fileId) })
    }

    if (action === "clear-override") {
      const file = await clearFileRetentionOverride(fileId)
      await logStorageAudit("retention_override_cleared", { detail: existing.objectKey, userId: session.userId })
      return NextResponse.json({ ok: true, file })
    }

    if (action === "override") {
      let file
      if (body.expiresAt !== undefined) {
        file = await setFileRetention(fileId, { expiresAt: body.expiresAt })
      } else {
        const mode = body.rule?.mode
        if (mode === "permanent") {
          file = await setFileRetention(fileId, { mode: "permanent" })
        } else {
          const amount = Number(body.rule?.amount)
          const unit = body.rule?.unit
          if (!Number.isFinite(amount) || !isRetentionUnit(unit)) {
            return NextResponse.json({ error: "Invalid rule" }, { status: 400 })
          }
          file = await setFileRetention(fileId, { mode: "duration", amount, unit })
        }
      }
      await logStorageAudit("retention_override_set", { detail: existing.objectKey, userId: session.userId })
      return NextResponse.json({ ok: true, file })
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
