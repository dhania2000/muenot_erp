import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { searchParties, type PartyKind } from "@/lib/legal-esign-parties"

export const runtime = "nodejs"

const KINDS: PartyKind[] = ["employee", "client", "vendor"]

/**
 * Signer picker source — resolves candidate signers from the EXISTING masters
 * (employees / clients / vendors). Never a parallel party store (Phases 6, 56).
 */
export async function GET(request: NextRequest) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = request.nextUrl.searchParams
  const kind = (sp.get("kind") || "employee") as PartyKind
  if (!KINDS.includes(kind)) return NextResponse.json({ error: "Unknown party kind" }, { status: 400 })
  const search = sp.get("search") || ""
  const records = await searchParties(kind, search, Math.min(Number(sp.get("limit")) || 20, 50))
  return NextResponse.json({ records })
}
