import { NextResponse } from "next/server"
import { effectiveTenantId, requireTenantAdmin } from "@/lib/platform-guard"
import { ImportValidationError, isValidBatchIdempotencyKey } from "@/lib/data-import-batches-model"
import { BatchImportNotFoundError, BatchImportStateError } from "@/lib/data-import-batches-store"
import type { ImportActor } from "@/lib/data-import-store"

/**
 * Shared plumbing for the batched import API: every route is tenant-admin
 * gated, derives the tenant ONLY from the server-side session (never from the
 * request), and maps store errors to stable HTTP statuses.
 */
export type BatchRouteContext = { tenantId: number | null; actor: ImportActor }

export async function batchImportGuard(): Promise<{ ok: true; ctx: BatchRouteContext } | { ok: false; response: NextResponse }> {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return { ok: false, response: NextResponse.json({ error: guard.reason }, { status: guard.status }) }
  return {
    ok: true,
    ctx: {
      tenantId: effectiveTenantId(guard.ctx),
      actor: {
        userId: guard.session.userId,
        name: guard.session.name,
        email: guard.session.email,
        role: guard.ctx.tenantRole,
      } as ImportActor,
    },
  }
}

export function parseJobId(raw: string): number | null {
  if (!/^\d{1,12}$/.test(raw)) return null
  const id = Number(raw)
  return id > 0 ? id : null
}

/** Idempotency key from the `Idempotency-Key` header, falling back to the body. */
export function readIdempotencyKey(request: Request, body?: { idempotencyKey?: unknown }): string | null {
  const key = request.headers.get("idempotency-key") ?? body?.idempotencyKey
  return isValidBatchIdempotencyKey(key) ? key : null
}

export function batchErrorResponse(err: unknown): NextResponse {
  if (err instanceof BatchImportNotFoundError) return NextResponse.json({ error: "Import not found" }, { status: 404 })
  if (err instanceof BatchImportStateError) return NextResponse.json({ error: err.message }, { status: 409 })
  if (err instanceof ImportValidationError) return NextResponse.json({ error: err.message }, { status: 422 })
  console.error("[data-import-batches] unexpected error", err instanceof Error ? err.message : err)
  return NextResponse.json({ error: "The import request could not be processed" }, { status: 500 })
}
