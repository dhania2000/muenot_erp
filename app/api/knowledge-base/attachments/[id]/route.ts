import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureKbSchema, canView, canManage, resolveEmployee, employeeCanSee } from "@/lib/knowledge-base"
import { openStoredObject } from "@/lib/storage"

export const dynamic = "force-dynamic"

// GET /api/knowledge-base/attachments/[id] — authorized download proxy.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canView(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureKbSchema()

  const id = Number((await params).id)
  const att = (await query<any[]>(
    "SELECT id, article_id, file_name, file_type, storage_url, uploaded_by FROM kb_attachments WHERE id = ? LIMIT 1",
    [id],
  ))[0]
  if (!att) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const manage = await canManage(session)
  if (!manage) {
    if (!att.article_id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const emp = await resolveEmployee(session)
    if (!(await employeeCanSee(att.article_id, emp)))
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let obj
  try {
    obj = await openStoredObject(att.storage_url)
  } catch {
    return NextResponse.json({ error: "File unavailable" }, { status: 502 })
  }
  const body = obj.body instanceof Buffer ? new Uint8Array(obj.body) : (obj.body as ReadableStream<Uint8Array>)
  return new NextResponse(body as any, {
    headers: {
      "Content-Type": att.file_type || obj.contentType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${encodeURIComponent(att.file_name)}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
