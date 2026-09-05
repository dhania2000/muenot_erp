import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deleteGoogleAccount } from "@/lib/google-accounts"

export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await deleteGoogleAccount(session.userId)
  return NextResponse.json({ success: true })
}
