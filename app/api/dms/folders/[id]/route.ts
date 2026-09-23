import { NextRequest, NextResponse } from "next/server"
import { requireDms, isResponse } from "@/lib/dms/request"
import { listFolders, updateFolder, deleteFolder } from "@/lib/dms"

export const runtime = "nodejs"

/** Only the folder creator/owner or a tenant admin may rename or delete it. */
async function canManageFolder(
  actor: { userId: number; isAdmin: boolean },
  folderId: number,
): Promise<boolean> {
  if (actor.isAdmin) return true
  const folder = (await listFolders()).find((f) => f.id === folderId)
  if (!folder) return false
  return folder.ownerId === actor.userId || folder.createdBy === actor.userId
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const folderId = Number(id)
  if (!(await canManageFolder(ctx.actor, folderId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const body = await req.json().catch(() => ({}))
  const patch: { name?: string; parentId?: number | null } = {}
  if ("name" in body) patch.name = String(body.name)
  if ("parentId" in body) patch.parentId = body.parentId == null ? null : Number(body.parentId)
  await updateFolder(folderId, patch)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  const { id } = await params
  const folderId = Number(id)
  if (!(await canManageFolder(ctx.actor, folderId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  await deleteFolder(folderId)
  return NextResponse.json({ ok: true })
}
