import { NextResponse } from "next/server"
import { PartnerError } from "@/lib/partners/model"

export async function readJson(req: Request): Promise<any> {
  try {
    return await req.json()
  } catch {
    throw new PartnerError("Invalid JSON body", "INVALID_JSON", 400)
  }
}

export function partnerErrorResponse(err: unknown, fallback: string) {
  if (err instanceof PartnerError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
  }
  console.error(`[partners] ${fallback}:`, err)
  return NextResponse.json({ error: fallback }, { status: 500 })
}
