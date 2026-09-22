import "server-only"
/**
 * SPEC 51 — Standard success/error envelopes + response headers.
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

/** The version string advertised on every response and accepted by the router. */
export const API_VERSION = "2024-10-01"
export const SUPPORTED_VERSIONS = new Set([API_VERSION])

export type PageMeta = {
  page: number
  per_page: number
  total?: number
  total_pages?: number
  sort?: string
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
  opts: { requestId: string; status: number; details?: unknown; headers?: Record<string, string> },
): NextResponse {
  const error: Record<string, unknown> = { code, message, request_id: opts.requestId }
  if (opts.details !== undefined) error.details = opts.details
  return NextResponse.json(
    { error },
    { status: opts.status, headers: baseHeaders(opts.requestId, opts.headers) },
  )
}

export function jsonErrorFromApiError(
  err: ApiError,
  requestId: string,
  headers?: Record<string, string>,
): NextResponse {
  return jsonError(err.code, err.message, {
    requestId,
    status: err.status,
    details: err.details,
    headers,
  })
}
