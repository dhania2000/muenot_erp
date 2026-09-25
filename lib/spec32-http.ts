import { NextResponse } from "next/server"

/** Shared response helpers for the Spec32 onboarding / help / release-notes APIs. */
export const NO_STORE = { "Cache-Control": "private, no-store" }

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

/**
 * Turn a thrown error into a JSON response. Our domain errors
 * (OnboardingError, ProductUpdateError) expose { message, code, status };
 * anything else is logged and returned as a generic 500 so internals never leak.
 */
export function errorResponse(err: unknown, fallback: string) {
  const e = err as { status?: number; code?: string; message?: string }
  if (e && typeof e.status === "number" && typeof e.code === "string") {
    return NextResponse.json({ error: e.message ?? fallback, code: e.code }, { status: e.status, headers: NO_STORE })
  }
  console.error(`[spec32] ${fallback}:`, (err as Error)?.message)
  return NextResponse.json({ error: fallback }, { status: 500, headers: NO_STORE })
}
