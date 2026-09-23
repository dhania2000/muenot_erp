import "server-only"
import { monitorLogger } from "@/lib/system-monitoring"
import { requestReference, safeDbError } from "@/lib/system-monitoring-core"

/** Incremental adapter for API routes; does not expose internal exceptions. */
export function captureApiError(input: {
  request: Request; service: string; operation: string; error: unknown; status?: number
  code?: string; tenantId?: number | null; userId?: number | null; startedAt?: number
}): Response {
  const status = input.status && input.status >= 400 && input.status <= 599 ? input.status : 500
  const requestId = requestReference(input.request.headers.get("x-request-id"))
  const expected = status >= 400 && status < 500
  const event = {
    service: input.service, operation: input.operation,
    errorCode: input.code || (expected ? "API_REJECTED" : "API_FAILURE"),
    message: expected ? "API request rejected" : "API request failed",
    tenantId: input.tenantId, userId: input.userId,
    route: new URL(input.request.url).pathname, method: input.request.method,
    httpStatus: status, requestId,
    durationMs: input.startedAt ? Math.max(0, Date.now() - input.startedAt) : undefined,
    metadata: expected ? null : safeDbError(input.error),
  }
  if (expected) monitorLogger.warning(event)
  else monitorLogger.error(event)
  return Response.json({ error: expected ? "Request could not be completed" : "Something went wrong", code: event.errorCode, requestId }, { status, headers: { "x-request-id": requestId } })
}
