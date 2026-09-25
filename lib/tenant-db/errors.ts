/** Stable, credential-free database infrastructure errors for logs and APIs. */
export type TenantDbFailure = {
  code: "AUTH_FAILED" | "NETWORK_FAILED" | "TLS_FAILED" | "DATABASE_NOT_FOUND" |
    "INSUFFICIENT_PRIVILEGES" | "TIMEOUT" | "POLICY_BLOCKED" | "UNKNOWN_ERROR"
  message: string
}

export function classifyTenantDbFailure(error: unknown): TenantDbFailure {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : ""
  switch (code) {
    case "ER_ACCESS_DENIED_ERROR":
      return { code: "AUTH_FAILED", message: "Database authentication failed." }
    case "ER_BAD_DB_ERROR":
      return { code: "DATABASE_NOT_FOUND", message: "Configured database was not found." }
    case "ER_DBACCESS_DENIED_ERROR":
    case "ER_TABLEACCESS_DENIED_ERROR":
    case "ER_SPECIFIC_ACCESS_DENIED_ERROR":
      return { code: "INSUFFICIENT_PRIVILEGES", message: "Database account lacks required privileges." }
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
    case "PROTOCOL_SEQUENCE_TIMEOUT":
      return { code: "TIMEOUT", message: "Database connection timed out." }
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "ECONNREFUSED":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ECONNRESET":
      return { code: "NETWORK_FAILED", message: "Database network connection failed." }
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return { code: "TLS_FAILED", message: "Database TLS verification failed." }
    default:
      return { code: "UNKNOWN_ERROR", message: "Database operation failed." }
  }
}
