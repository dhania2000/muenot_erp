import "server-only"
/**
 * Standard success/error envelopes + response headers.
 * ---------------------------------------------------------------------------
 * Success:  { "data": <payload>, "meta"?: <pagination/etc>, "request_id": "..." }
 * Error:    { "error": { "code", "message", "details?", "request_id" } }
 *
 * Every response carries `X-Request-Id` and `X-API-Version` so callers can
 * correlate logs and pin behavior. Rate-limit headers are attached by the
 * shared handler when a limit is configured.
 */
import { NextResponse } from "next/server"
import { ApiError, type ApiErrorCode } from "@/lib/api-platform/errors"
import { DEFAULT_API_VERSION, SUPPORTED_API_VERSIONS } from "@/lib/api-platform/versioning"

/**
 * The default version advertised when no `X-API-Version` is negotiated, plus
 * the full supported set. Both derive from the single source of truth in
 * lib/api-platform/versioning.ts so the version surface is defined once.
 */
export const API_VERSION = DEFAULT_API_VERSION
export const SUPPORTED_VERSIONS = SUPPORTED_API_VERSIONS

/** Trace fields stamped onto error envelopes for correlation with logs. */
export type ErrorTrace = { tenantId?: number | null; actorId?: string | null; traceId?: string | null }

export type PageMeta = {
  page: number
  per_page: number
  total?: number
  total_pages?: number
  sort?: string
  sandbox_id?: string
}

function baseHeaders(requestId: string, extra?: Record<string, string>): Record<string, string> {
  return {
    "X-Request-Id": requestId,
    "X-API-Version": API_VERSION,
    ...(extra ?? {}),
  }
}

export function jsonOk<T>(
  data: T,
  opts: { requestId: string; status?: number; meta?: PageMeta; headers?: Record<string, string> },
): NextResponse {
  const body: Record<string, unknown> = { data, request_id: opts.requestId }
  if (opts.meta) body.meta = opts.meta
  return NextResponse.json(body, {
    status: opts.status ?? 200,
    headers: baseHeaders(opts.requestId, opts.headers),
  })
}

export function jsonError(
  code: ApiErrorCode,
  message: string,
  opts: {
    requestId: string
    status: number
    details?: unknown
    headers?: Record<string, string>
    trace?: ErrorTrace
  },
): NextResponse {
  const error: Record<string, unknown> = { code, message, request_id: opts.requestId }
  if (opts.details !== undefined) error.details = opts.details
  // Stamp the correlating trace fields so a client's error report alone is
  // enough to locate the exact server-side audit record.
  if (opts.trace?.tenantId != null) error.tenant_id = opts.trace.tenantId
  if (opts.trace?.actorId != null) error.actor_id = opts.trace.actorId
  if (opts.trace?.traceId != null) error.trace_id = opts.trace.traceId
  return NextResponse.json(
    { error },
    { status: opts.status, headers: baseHeaders(opts.requestId, opts.headers) },
  )
}

export function jsonErrorFromApiError(
  err: ApiError,
  requestId: string,
  headers?: Record<string, string>,
  trace?: ErrorTrace,
): NextResponse {
  return jsonError(err.code, err.message, {
    requestId,
    status: err.status,
    details: err.details,
    headers,
    trace,
  })
}
