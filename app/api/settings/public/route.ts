import { NextResponse } from "next/server"
import { getPublicSettings } from "@/lib/settings/server"

// Non-secret, display-relevant settings for client hydration. No auth required
// (only public display values are returned; secret fields are never included).
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const values = await getPublicSettings()
    return NextResponse.json({ values })
  } catch {
    return NextResponse.json({ values: {} })
  }
}
