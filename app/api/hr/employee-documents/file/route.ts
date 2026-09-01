import { get } from "@vercel/blob"
import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const pathname = new URL(request.url).searchParams.get("pathname")
  if (!pathname) return NextResponse.json({ error: "Missing pathname" }, { status: 400 })
  const owned = await query<any[]>("SELECT id FROM hr_employee_documents WHERE file_path=? LIMIT 1", [pathname])
  if (!owned.length) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const result = await get(pathname, { access: "private", ifNoneMatch: request.headers.get("if-none-match") ?? undefined })
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (result.statusCode === 304) return new NextResponse(null, { status: 304, headers: { ETag: result.blob.etag } })
  return new NextResponse(result.stream, { headers: { "Content-Type": result.blob.contentType, "Content-Disposition": `inline; filename="${result.blob.pathname.split("/").pop()}"`, ETag: result.blob.etag, "Cache-Control": "private, no-cache" } })
}
