import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const rows = await query<any[]>("SELECT 1 AS ok")
    const tables = await query<any[]>("SHOW TABLES")
    return NextResponse.json({
      connected: true,
      ok: rows?.[0]?.ok ?? null,
      tableCount: Array.isArray(tables) ? tables.length : 0,
      host: process.env.DB_HOST ?? null,
      db: process.env.DB_NAME ?? null,
    })
  } catch (err: any) {
    return NextResponse.json(
      {
        connected: false,
        code: err?.code ?? null,
        message: err?.message ?? String(err),
        host: process.env.DB_HOST ?? null,
        db: process.env.DB_NAME ?? null,
      },
      { status: 500 },
    )
  }
}
