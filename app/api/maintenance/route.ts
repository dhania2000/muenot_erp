import { NextRequest, NextResponse } from "next/server"
import { evaluateMaintenanceForSession } from "@/lib/maintenance/enforce"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MODULE_KEY_RE = /^[a-z][a-z0-9_-]{1,40}$/

/**
 * Spec28 (#125) — What maintenance applies to the signed-in caller right now.
 * The tenant is always taken from the verified session; `module` is only a
 * lookup filter and cannot widen what the caller sees.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("module")
  const moduleKey = raw && MODULE_KEY_RE.test(raw) ? raw : null
  try {
    const gate = await evaluateMaintenanceForSession(moduleKey)
    const body = gate.blocked
      ? { blocked: true, message: gate.message, retryAfter: gate.retryAfter, window: publicWindow(gate.window) }
      : {
          blocked: false,
          bypassing: gate.bypassed ? publicWindow(gate.bypassed) : null,
          upcoming: gate.upcoming.map(publicWindow),
          activeModules: gate.activeModules,
        }
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ blocked: false, bypassing: null, upcoming: [], activeModules: [] })
  }
}

function publicWindow(w: { id: number; scope: string; moduleKey: string | null; title: string; message: string; startsAt: string; endsAt: string | null }) {
  return { id: w.id, scope: w.scope, moduleKey: w.moduleKey, title: w.title, message: w.message, startsAt: w.startsAt, endsAt: w.endsAt }
}
