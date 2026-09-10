import { NextResponse } from "next/server"
import { query } from "@/lib/db"

// Public route — serves career-site images stored in the database so they can
// render on the public careers pages without any external storage provider.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const rows = await query<Array<{ mime: string; data: Buffer }>>(
    "SELECT mime, data FROM careers_images WHERE id = ? LIMIT 1",
    [id],
  )
  const row = rows[0]
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as unknown as ArrayBuffer)
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": row.mime || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
