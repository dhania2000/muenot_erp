import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listSkills, createSkill } from "@/lib/recruit-db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const skills = await listSkills()
  return NextResponse.json({ skills })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  if (!body.name?.trim()) return NextResponse.json({ error: "Skill name is required" }, { status: 400 })
  try {
    const result = await createSkill(body.name, session.userId)
    return NextResponse.json(result, { status: 201 })
  } catch (e: any) {
    if (e?.code === "ER_DUP_ENTRY") return NextResponse.json({ error: "Skill already exists" }, { status: 409 })
    throw e
  }
}
