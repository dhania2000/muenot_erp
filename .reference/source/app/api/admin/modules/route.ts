import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getAllModulesWithFeatures } from "@/lib/permissions"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const modules = await getAllModulesWithFeatures()
  return NextResponse.json({ modules })
}
