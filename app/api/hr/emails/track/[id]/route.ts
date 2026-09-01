import { NextResponse } from "next/server"
import { query } from "@/lib/db"

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await query("UPDATE hr_emails SET open_count = open_count + 1, opened_at = COALESCE(opened_at, NOW()) WHERE thread_id = ?", [id])
  return new NextResponse(PIXEL, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate" } })
}
