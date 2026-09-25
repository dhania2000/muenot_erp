/**
 * A tiny in-memory MySQL-ish engine for unit-testing the Spec24 privacy stores
 * without a real database. It understands only the regular query shapes those
 * stores emit — CREATE TABLE, INSERT, SELECT (incl. COUNT), UPDATE, DELETE with
 * `col = ?`, `IN (...)`, `NOT IN (...)`, ORDER BY and LIMIT — which is enough to
 * exercise tenant scoping, lifecycle transitions, idempotency and failure paths
 * against the store's ACTUAL SQL rather than a hand-stubbed sequence.
 *
 * Anything it cannot parse (e.g. the catalog-table lookups the DSAR executor
 * runs against `employees`, `leads`, …) is delegated to an optional custom
 * handler so a test can drive those explicitly.
 */

export type Row = Record<string, any>

/** Return `undefined` to fall through to the built-in engine. */
export type CustomHandler = (sql: string, params: any[]) => any | undefined

function splitTopLevel(input: string, sep = ","): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ""
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (ch === sep && depth === 0) {
      out.push(cur.trim())
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Split on a top-level ` AND ` (case-insensitive), respecting parens/quotes. */
function splitTopLevelAnd(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ""
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (depth === 0 && input.slice(i, i + 5).toUpperCase() === " AND ") {
      out.push(cur.trim())
      cur = ""
      i += 4
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function unback(token: string): string {
  return token.replace(/`/g, "").trim()
}

function literal(token: string): any {
  const t = token.trim()
  if (t === "NULL") return null
  if (/^'.*'$/.test(t)) return t.slice(1, -1)
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return t
}

function parseInList(token: string): Set<string> {
  const inner = token.slice(token.indexOf("(") + 1, token.lastIndexOf(")"))
  return new Set(splitTopLevel(inner).map((v) => String(literal(v))))
}

type Condition = (row: Row, params: any[]) => boolean

/**
 * Parse a WHERE clause into row predicates. Placeholders (`?`) are bound to a
 * FIXED positional index rather than consumed by `Array.shift()`, so the same
 * `params` array can be evaluated against every row without being mutated —
 * shifting a shared array corrupted matching as soon as a table held >1 row.
 * `paramCount` is how many `?` the clause consumed, so callers can locate any
 * trailing placeholder (e.g. `LIMIT ?`).
 */
function parseWhere(where: string): { conds: Condition[]; paramCount: number } {
  const parts = splitTopLevelAnd(where).map((p) => p.trim()).filter(Boolean)
  const conds: Condition[] = []
  let ph = 0
  for (const part of parts) {
    const notIn = part.match(/^`?(\w+)`?\s+NOT\s+IN\s*(\(.*\))$/i)
    if (notIn) {
      const col = notIn[1]
      const set = parseInList(notIn[2])
      conds.push((row) => !set.has(String(row[col])))
      continue
    }
    const isIn = part.match(/^`?(\w+)`?\s+IN\s*(\(.*\))$/i)
    if (isIn) {
      const col = isIn[1]
      const set = parseInList(isIn[2])
      conds.push((row) => set.has(String(row[col])))
      continue
    }
    const eq = part.match(/^`?(\w+)`?\s*=\s*(.+)$/i)
    if (eq) {
      const col = eq[1]
      const rhs = eq[2].trim()
      if (rhs === "?") {
        const idx = ph++
        conds.push((row, params) => String(row[col]) === String(params[idx]))
      } else {
        const val = literal(rhs)
        conds.push((row) => String(row[col]) === String(val))
      }
      continue
    }
    throw new Error(`mini-sql: unsupported WHERE clause: "${part}"`)
  }
  return { conds, paramCount: ph }
}

export class MiniSql {
  private tables = new Map<string, Row[]>()
  private nextId = new Map<string, number>()
  private clock = 0
  custom: CustomHandler | null = null

  /** Wipe all data so each test starts from an empty database. */
  reset(): void {
    this.tables.clear()
    this.nextId.clear()
    this.clock = 0
    this.custom = null
  }

  private table(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, [])
    return this.tables.get(name)!
  }

  /** Test introspection: the current rows of a table. */
  rows(name: string): Row[] {
    return this.table(name)
  }

  private ts(): string {
    this.clock += 1
    return new Date(Date.UTC(2027, 0, 1) + this.clock * 1000).toISOString().slice(0, 19).replace("T", " ")
  }

  query = async (sql: string, params: any[] = []): Promise<any> => {
    const custom = this.custom?.(sql, params)
    if (custom !== undefined) return custom
    const norm = sql.replace(/\s+/g, " ").trim()

    if (/^CREATE TABLE/i.test(norm)) {
      const m = norm.match(/CREATE TABLE IF NOT EXISTS `?(\w+)`?/i)
      if (m) this.table(m[1])
      return []
    }

    if (/^INSERT INTO/i.test(norm)) {
      const m = norm.match(/^INSERT INTO `?(\w+)`? \((.*?)\) VALUES \((.*)\)$/i)
      if (!m) throw new Error(`mini-sql: cannot parse INSERT: ${norm}`)
      const table = m[1]
      const cols = splitTopLevel(m[2]).map(unback)
      const valTokens = splitTopLevel(m[3])
      const p = [...params]
      const row: Row = {}
      cols.forEach((col, i) => {
        const tok = valTokens[i].trim()
        row[col] = tok === "?" ? p.shift() : literal(tok)
      })
      const id = (this.nextId.get(table) ?? 0) + 1
      this.nextId.set(table, id)
      row.id = id
      row.created_at = row.created_at ?? this.ts()
      row.updated_at = this.ts()
      this.table(table).push(row)
      return { insertId: id, affectedRows: 1 }
    }

    if (/^SELECT/i.test(norm)) {
      const m = norm.match(/^SELECT (.+?) FROM `?(\w+)`?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (.+?))?$/i)
      if (!m) throw new Error(`mini-sql: cannot parse SELECT: ${norm}`)
      const [, projection, table, where, orderBy, limit] = m
      let rows = [...this.table(table)]
      let paramCount = 0
      if (where) {
        const parsed = parseWhere(where)
        paramCount = parsed.paramCount
        rows = rows.filter((row) => parsed.conds.every((c) => c(row, params)))
      }
      if (orderBy) {
        const keys = splitTopLevel(orderBy).map((k) => {
          const [col, dir] = k.trim().split(/\s+/)
          return { col: unback(col), desc: (dir ?? "ASC").toUpperCase() === "DESC" }
        })
        rows.sort((a, b) => {
          for (const { col, desc } of keys) {
            const av = a[col]
            const bv = b[col]
            if (av < bv) return desc ? 1 : -1
            if (av > bv) return desc ? -1 : 1
          }
          return 0
        })
      }
      if (limit) {
        const lim = limit.trim() === "?" ? Number(params[paramCount]) : Number(literal(limit))
        rows = rows.slice(0, lim)
      }
      if (/COUNT\(\*\)/i.test(projection)) {
        const alias = projection.match(/AS\s+`?(\w+)`?/i)?.[1] ?? "n"
        return [{ [alias]: rows.length }]
      }
      return rows.map((r) => ({ ...r }))
    }

    if (/^UPDATE/i.test(norm)) {
      const m = norm.match(/^UPDATE `?(\w+)`? SET (.+) WHERE (.+)$/i)
      if (!m) throw new Error(`mini-sql: cannot parse UPDATE: ${norm}`)
      const [, table, setClause, where] = m
      const p = [...params]
      const assigns = splitTopLevel(setClause).map((a) => {
        const eq = a.indexOf("=")
        const col = unback(a.slice(0, eq))
        const rhs = a.slice(eq + 1).trim()
        return { col, rhs }
      })
      // SET params are consumed before WHERE params (they appear first in SQL).
      const setValues = assigns.map(({ col, rhs }) => {
        if (rhs === "?") return { col, kind: "param" as const, value: p.shift() }
        if (/^NOW\(\)$/i.test(rhs)) return { col, kind: "now" as const }
        const coalesce = rhs.match(/^COALESCE\(\s*\?\s*,\s*`?(\w+)`?\s*\)$/i)
        if (coalesce) return { col, kind: "coalesce" as const, value: p.shift(), fallback: coalesce[1] }
        return { col, kind: "literal" as const, value: literal(rhs) }
      })
      const { conds } = parseWhere(where)
      let affected = 0
      for (const row of this.table(table)) {
        if (!conds.every((c) => c(row, p))) continue
        affected++
        for (const sv of setValues) {
          if (sv.kind === "param" || sv.kind === "literal") row[sv.col] = sv.value
          else if (sv.kind === "now") row[sv.col] = this.ts()
          else row[sv.col] = sv.value != null ? sv.value : row[sv.fallback!]
        }
        row.updated_at = this.ts()
      }
      return { affectedRows: affected }
    }

    if (/^DELETE FROM/i.test(norm)) {
      const m = norm.match(/^DELETE FROM `?(\w+)`?(?: WHERE (.+))?$/i)
      if (!m) throw new Error(`mini-sql: cannot parse DELETE: ${norm}`)
      const [, table, where] = m
      const p = [...params]
      const conds = where ? parseWhere(where).conds : []
      const rows = this.table(table)
      let affected = 0
      for (let i = rows.length - 1; i >= 0; i--) {
        if (conds.every((c) => c(rows[i], p))) {
          rows.splice(i, 1)
          affected++
        }
      }
      return { affectedRows: affected }
    }

    throw new Error(`mini-sql: unsupported SQL: ${norm}`)
  }
}
