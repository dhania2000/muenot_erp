import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listTasks, createTask, TaskError } from "@/lib/tasks/model"

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const sp = req.nextUrl.searchParams
    const assignee = Number(sp.get("assignee"))
    const rows = await listTasks({
      status: sp.get("status") ?? undefined,
      priority: sp.get("priority") ?? undefined,
      assigneeId: Number.isSafeInteger(assignee) && assignee > 0 ? assignee : undefined,
      q: sp.get("q") ?? undefined,
      view: (sp.get("view") as any) ?? "all",
      overdue: sp.get("overdue") === "1",
    })
    return NextResponse.json({ rows })
  } catch (err) {
    const status = err instanceof TaskError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const body = await req.json()
    const result = await createTask(body)
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    const status = err instanceof TaskError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
