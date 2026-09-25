import { NextResponse } from "next/server"
import { CustomerSuccessError } from "@/lib/customer-success/model"

export const NO_STORE = { "Cache-Control": "private, no-store" }

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new CustomerSuccessError("Request body must be valid JSON", "INVALID_JSON")
  }
}

export function csErrorResponse(err: unknown, fallback: string) {
  if (err instanceof CustomerSuccessError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers: NO_STORE })
  }
  console.error(`[customer-success] ${fallback}:`, (err as Error)?.message)
  return NextResponse.json({ error: fallback }, { status: 500, headers: NO_STORE })
}
