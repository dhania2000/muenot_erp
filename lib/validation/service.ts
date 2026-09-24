import "server-only"
/**
 * SPEC 102 — Data Validation Engine: server integration (Phase 3).
 * ---------------------------------------------------------------------------
 * The thin server layer that turns the pure engine (model.ts) into something an
 * API route, Server Action or import worker calls directly. It does the one
 * thing the pure model can't: resolve UNIQUENESS against the database, then it
 * runs the engine and, on failure, throws the app's standard validation error
 * so every caller reports the identical envelope.
 *
 * Uniqueness is resolved generically via a caller-supplied `checkUnique`
 * callback OR the built-in `tableUniqueResolver`, so the framework never has to
 * know about any specific module's tables.
 */
import { query } from "@/lib/db"
import { ApiError } from "@/lib/api-platform/errors"
import {
  collectUniqueChecks,
  uniqueKey,
  validateRecord,
  type RecordData,
  type UniqueCheck,
  type ValidateOptions,
  type ValidationResult,
  type ValidationSchema,
} from "./model"

/** Resolve each declared uniqueness check to `true` when the value is taken. */
export type UniqueResolver = (checks: UniqueCheck[]) => Promise<Record<string, boolean>>

export type RunValidationOptions = Omit<ValidateOptions, "duplicates"> & {
  checkUnique?: UniqueResolver
}

/**
 * Validate a record end-to-end: resolve uniqueness (if the schema declares any
 * and a resolver is provided), then run the pure engine. Returns the structured
 * result — it never throws for a validation failure.
 */
export async function runValidation(
  schema: ValidationSchema,
  record: RecordData,
  opts: RunValidationOptions = {},
): Promise<ValidationResult> {
  const { checkUnique, ...engineOpts } = opts
  let duplicates: Record<string, boolean> | undefined
  if (checkUnique) {
    const checks = collectUniqueChecks(schema, record)
    if (checks.length) duplicates = await checkUnique(checks)
  }
  return validateRecord(schema, record, { ...engineOpts, duplicates })
}

/**
 * Validate and, on failure, throw the standard `validation_failed` ApiError
 * (HTTP 422) with `{ fields }` details — matching lib/api-platform/errors.ts so
 * routes never hand-roll the shape. Returns the clean result on success.
 */
export async function assertValid(
  schema: ValidationSchema,
  record: RecordData,
  opts: RunValidationOptions = {},
): Promise<ValidationResult> {
  const result = await runValidation(schema, record, opts)
  if (!result.ok) {
    throw new ApiError("validation_failed", "One or more fields are invalid", {
      fields: result.firstErrors,
      issues: result.issues,
    })
  }
  return result
}

/**
 * A ready-made uniqueness resolver that checks one tenant-scoped table where
 * each unique `scope` maps to a column. Excludes the current record on update.
 *
 *   tableUniqueResolver({
 *     table: "clients", tenantId, columnFor: { email: "email", gstin: "gstin" },
 *     excludeId, idColumn: "id",
 *   })
 *
 * `columnFor` maps a uniqueness SCOPE to its physical column; anything not
 * mapped is skipped (treated as unique) so a partial config can't false-positive.
 */
export function tableUniqueResolver(config: {
  table: string
  tenantId?: number
  columnFor: Record<string, string>
  idColumn?: string
  excludeId?: string | number | null
}): UniqueResolver {
  const { table, tenantId, columnFor, idColumn = "id", excludeId } = config
  return async (checks) => {
    const out: Record<string, boolean> = {}
    for (const check of checks) {
      const column = columnFor[check.scope]
      if (!column) continue
      const where: string[] = [`\`${column}\` = ?`]
      const args: unknown[] = [check.value]
      if (tenantId != null) {
        where.push("tenant_id = ?")
        args.push(tenantId)
      }
      if (excludeId != null && excludeId !== "") {
        where.push(`\`${idColumn}\` <> ?`)
        args.push(excludeId)
      }
      const rows = (await query<Array<{ n: number }>>(
        `SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where.join(" AND ")}`,
        args,
      )) as Array<{ n: number }>
      out[uniqueKey(check.field, check.scope)] = Number(rows?.[0]?.n ?? 0) > 0
    }
    return out
  }
}
