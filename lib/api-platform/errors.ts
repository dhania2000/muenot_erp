import "server-only"
/**
 * SPEC 51 — Standard error model for the public API.
 * ---------------------------------------------------------------------------
 * Every `/api/v1/*` failure serializes to a single, stable envelope:
 *
 *   { "error": { "code": "validation_failed", "message": "...",
 *                "details": { ... }, "request_id": "req_..." } }
 *
 * `code` is a machine-stable string (never localized, never renumbered);
 * `message` is human-readable; `details` is optional structured context
 * (e.g. per-field validation errors). Handlers throw `ApiError` and the
 * shared handler (lib/api-platform/handler.ts) renders it — so no route ever
 * hand-rolls an error shape.
 */

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "validation_failed"
  | "conflict"
  | "idempotency_conflict"
  | "unsupported_version"
  | "rate_limited"
  | "rate_limit_unavailable"
  | "ip_not_allowed"
  | "internal_error"

export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  validation_failed: 422,
  conflict: 409,
  idempotency_conflict: 409,
  unsupported_version: 400,
  rate_limited: 429,
  rate_limit_unavailable: 503,
  ip_not_allowed: 403,
  internal_error: 500,
}

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: ApiErrorCode, message?: string, details?: unknown) {
    super(message ?? code)
    this.name = "ApiError"
    this.code = code
    this.status = ERROR_STATUS[code]
    this.details = details
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError
}

/** Convenience for the most common failure — invalid request input. */
export function validationError(fields: Record<string, string>): ApiError {
  return new ApiError("validation_failed", "One or more fields are invalid", { fields })
}
