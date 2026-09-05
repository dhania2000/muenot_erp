import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const rows = await query<any[]>(
    `SELECT filename, content_type, size, data FROM email_attachments WHERE id = ? LIMIT 1`,
    [id],
  )
  const row = rows[0]
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const data: Buffer = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data)
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Content-Length": String(row.size ?? data.length),
      "Content-Disposition": `inline; filename="${encodeURIComponent(row.filename)}"`,
      "Cache-Control": "private, max-age=3600",
    },
  })
}
