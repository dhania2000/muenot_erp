import { NextRequest, NextResponse } from "next/server"
import { createRecruitmentHandlers } from "@/lib/recruitment-crud"

// One route serves every config-driven Recruitment module. The [key] segment
// (e.g. "job-requisitions", "screening") selects the ModuleConfig, and the
// shared CRUD factory handles auto IDs, server-side calculations and the
// created_at / updated_at system columns for that module's dedicated table.

type Handlers = ReturnType<typeof createRecruitmentHandlers>
const cache = new Map<string, Handlers>()

function getHandlers(key: string): Handlers | null {
  if (cache.has(key)) return cache.get(key)!
  try {
    const handlers = createRecruitmentHandlers(key)
    cache.set(key, handlers)
    return handlers
  } catch {
    return null
  }
}

async function withHandlers(
  params: Promise<{ key: string }>,
  run: (h: Handlers) => Promise<Response>,
) {
  const { key } = await params
  const handlers = getHandlers(key)
  if (!handlers) return NextResponse.json({ error: "Unknown recruitment module" }, { status: 404 })
  return run(handlers)
}

type Ctx = { params: Promise<{ key: string }> }

export function GET(req: NextRequest, ctx: Ctx) {
  return withHandlers(ctx.params, (h) => h.GET(req))
}
export function POST(req: NextRequest, ctx: Ctx) {
  return withHandlers(ctx.params, (h) => h.POST(req))
}
export function PATCH(req: NextRequest, ctx: Ctx) {
  return withHandlers(ctx.params, (h) => h.PATCH(req))
}
export function DELETE(req: NextRequest, ctx: Ctx) {
  return withHandlers(ctx.params, (h) => h.DELETE(req))
}
