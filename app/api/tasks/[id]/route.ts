import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getTaskDetail, updateTask, deleteTask, propagateUnblock, TaskError } from "@/lib/tasks/model"

function parseId(raw: string): number {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  try {
    return NextResponse.json(await getTaskDetail(id))
  } catch (err) {
    const status = err instanceof TaskError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  try {
    const body = await req.json()
    await updateTask(id, body)
    // When a task is resolved, re-evaluate any tasks that depended on it.
    if (body.status === "Done" || body.status === "Cancelled") await propagateUnblock(id)
    return NextResponse.json(await getTaskDetail(id))
  } catch (err) {
    const status = err instanceof TaskError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  try {
    await deleteTask(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const status = err instanceof TaskError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
