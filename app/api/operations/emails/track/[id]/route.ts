import { query } from "@/lib/db"
import { NextResponse } from "next/server"
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; await query("UPDATE operations_emails SET opened_at=COALESCE(opened_at,NOW()) WHERE id=?", [id]); return new NextResponse(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/Scx7WQAAAABJRU5ErkJggg==", "base64"), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } }) }
