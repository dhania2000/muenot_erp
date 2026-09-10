import { NextResponse } from "next/server"
import { query } from "@/lib/db"

// Serves a candidate resume stored in the database. Kept accessible so the
// application's resume link works from the recruiter views without external storage.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const rows = await query<Array<{ mime: string; filename: string | null; data: Buffer }>>(
    "SELECT mime, filename, data FROM recruit_resumes WHERE id = ? LIMIT 1",
    [id],
  )
  const row = rows[0]
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as unknown as ArrayBuffer)
  const disposition = row.filename ? `inline; filename="${row.filename.replace(/"/g, "")}"` : "inline"
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": row.mime || "application/octet-stream",
      "Content-Disposition": disposition,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
