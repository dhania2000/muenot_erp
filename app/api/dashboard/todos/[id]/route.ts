import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deleteTodo, updateTodo } from "@/lib/personal-dashboard"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const todoId = Number(id)
  if (!Number.isFinite(todoId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const body = await request.json().catch(() => ({}))
  const ok = await updateTodo(session.userId, todoId, {
    done: body?.done,
    title: body?.title,
    priority: body?.priority,
    due_date: body?.due_date,
  })
  if (!ok) return NextResponse.json({ error: "Not found or no changes" }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const todoId = Number(id)
  if (!Number.isFinite(todoId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const ok = await deleteTodo(session.userId, todoId)
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
