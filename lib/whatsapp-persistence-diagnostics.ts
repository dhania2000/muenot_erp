/** Safe metadata for a failed WhatsApp credential write. Never include SQL or parameters. */
export class WhatsAppPersistenceError extends Error {
  constructor(public readonly operation: string, public readonly original: unknown) {
    super(operation === "phone_ownership_conflict" ? "This phone number is already assigned to another workspace." : "WhatsApp connection persistence failed")
    this.name = "WhatsAppPersistenceError"
  }
}

type DatabaseError = { code?: unknown; sqlState?: unknown; errno?: unknown; sqlMessage?: unknown }
const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z_][a-zA-Z0-9_.]{0,127}$/.test(value) ? value : undefined

export function safeWhatsAppPersistenceError(error: unknown) {
  const operation = error instanceof WhatsAppPersistenceError ? error.operation : "connection_finalization"
  const original = error instanceof WhatsAppPersistenceError ? error.original : error
  const db = original && typeof original === "object" ? original as DatabaseError : {}
  const databaseErrorCode = identifier(db.code)
  const sqlState = typeof db.sqlState === "string" && /^[A-Z0-9]{5}$/.test(db.sqlState) ? db.sqlState : undefined
  const sqlMessage = typeof db.sqlMessage === "string" ? db.sqlMessage : ""
  const constraint = identifier(/for key ['`"]([^'`"]+)['`"]/.exec(sqlMessage)?.[1])
  const column = identifier(/(?:Unknown column|column) ['`"]([^'`"]+)['`"]/.exec(sqlMessage)?.[1])
  const sanitizedMessage = operation === "phone_ownership_conflict" ? "The phone number is assigned to another tenant."
    : databaseErrorCode === "ER_DUP_ENTRY" ? "Unique constraint rejected the connection write."
    : databaseErrorCode === "ER_BAD_FIELD_ERROR" ? "The connection table is missing a required column."
    : databaseErrorCode === "ER_NO_DEFAULT_FOR_FIELD" || databaseErrorCode === "ER_BAD_NULL_ERROR" ? "A required connection field was absent."
    : databaseErrorCode === "ER_DATA_TOO_LONG" ? "A connection value exceeds its column size."
    : databaseErrorCode === "ER_NO_REFERENCED_ROW_2" ? "A referenced tenant or user row does not exist."
    : databaseErrorCode === "ER_NO_SUCH_TABLE" ? "The connection table does not exist."
    : databaseErrorCode === "ER_LOCK_WAIT_TIMEOUT" || databaseErrorCode === "ER_LOCK_DEADLOCK" ? "The connection write was blocked by a database lock."
    : operation === "token_encryption" ? "Credential encryption failed."
    : databaseErrorCode ? "The database rejected the connection write." : "Connection persistence failed before a database error was available."
  return { operation, ...(databaseErrorCode ? { databaseErrorCode } : {}), ...(sqlState ? { sqlState } : {}),
    ...(constraint ? { constraint } : {}), ...(column ? { column } : {}), sanitizedMessage }
}

export async function persistenceStep<T>(operation: string, fn: () => Promise<T> | T): Promise<T> {
  try { return await fn() } catch (error) { throw new WhatsAppPersistenceError(operation, error) }
}
