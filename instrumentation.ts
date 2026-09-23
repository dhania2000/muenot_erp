import type { Instrumentation } from "next"

export function register() {
  // Reserved for runtime-specific initialization. No external transport is
  // required: onRequestError writes to the existing ERP monitoring store.
}

/** Next.js reports otherwise-unhandled server failures here. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { persistMonitorEvent, requestReference, safeDbError } = await import("@/lib/system-monitoring")
  const rawId = request.headers["x-request-id"]
  const requestId = requestReference(typeof rawId === "string" ? rawId : Array.isArray(rawId) ? rawId[0] : null)
  await persistMonitorEvent({
    severity: "ERROR",
    service: context.routeType === "route" ? "api" : "next_server",
    component: context.routeType,
    operation: "unhandled_error",
    errorCode: "UNHANDLED_SERVER_ERROR",
    message: "Unhandled server error",
    route: request.path.split("?")[0],
    method: request.method,
    requestId,
    metadata: { routerKind: context.routerKind, routePath: context.routePath, ...safeDbError(error) },
  })
}
