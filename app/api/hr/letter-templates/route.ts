import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listTemplates, createTemplate } from "@/lib/hr-letters-templates"

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const sp = new URL(request.url).searchParams
  const templates = await listTemplates({
    status: sp.get("status") || undefined,
    category: sp.get("category") || undefined,
    event_key: sp.get("event_key") || undefined,
    audience: sp.get("audience") || undefined,
    q: sp.get("q") || undefined,
  })
  return NextResponse.json({ templates })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  try {
    const template = await createTemplate(body, session.userId)
    return NextResponse.json({ template }, { status: 201 })
  } catch (error: any) {
    if (error?.code === "ER_DUP_ENTRY")
      return NextResponse.json({ error: "A template with this name already exists" }, { status: 409 })
    return NextResponse.json({ error: error?.message || "Failed to create template" }, { status: 400 })
  }
}
