import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { createTodo } from "@/lib/personal-dashboard"

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const title = String(body?.title || "").trim()
  if (!title) return NextResponse.json({ error: "Title is required" }, { status: 400 })
  const todo = await createTodo(session.userId, {
    title,
    priority: body?.priority,
    due_date: body?.due_date ?? null,
  })
  return NextResponse.json(todo, { status: 201 })
}
