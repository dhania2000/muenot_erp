// ---------------------------------------------------------------------------
// Legal Contracts — rendering + validation engine (pure, client-safe).
//
// A small Handlebars-like engine tailored to contract bodies (HTML from the
// rich editor OR plain text):
//   - {{ token }} / {{ a.b }}          variable substitution
//   - {{#if token}}…{{else}}…{{/if}}   conditional sections
//   - {{#each list}}…{{/each}}         iteration ({{this}} / {{prop}} inside)
//
// No server-only imports, so the editor and generate wizard render the exact
// same output in the browser that the server produces at generation time.
// ---------------------------------------------------------------------------

import { variablesForSource, allKnownTokens, extractVariables } from "@/lib/legal-contracts-shared"

export type ContractVars = Record<string, unknown>

const TAG_RE = /\{\{\s*(#if|#each|else|\/if|\/each)?\s*([\w.$]*)\s*\}\}/g

function lookup(scope: ContractVars, path: string): unknown {
  if (path === "this") return (scope as any).__this
  if (!path) return undefined
  return path.split(".").reduce<any>((obj, key) => (obj == null ? undefined : obj[key]), scope)
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value == null) return false
  if (typeof value === "string") return value.trim() !== ""
  if (typeof value === "number") return value !== 0
  return Boolean(value)
}

function findBlockEnd(
  tmpl: string,
  from: number,
  tag: "if" | "each",
): { elseAt: number | null; closeStart: number; closeEnd: number } | null {
  const re = new RegExp(TAG_RE.source, "g")
  re.lastIndex = from
  let depth = 0
  let elseAt: number | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(tmpl))) {
    const kind = m[1]
    if (kind === "#if" || kind === "#each") {
      depth++
    } else if (kind === "/if" || kind === "/each") {
      if (depth === 0) return { elseAt, closeStart: m.index, closeEnd: re.lastIndex }
      depth--
    } else if (kind === "else" && depth === 0 && tag === "if" && elseAt === null) {
      elseAt = m.index
    }
  }
  return null
}

function render(tmpl: string, scope: ContractVars): string {
  let out = ""
  const re = new RegExp(TAG_RE.source, "g")
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(tmpl))) {
    out += tmpl.slice(last, m.index)
    const kind = m[1]
    const name = m[2]

    if (!kind) {
      const v = lookup(scope, name)
      out += v == null ? "" : String(v)
      last = re.lastIndex
      continue
    }

    if (kind === "#if" || kind === "#each") {
      const type = kind === "#if" ? "if" : "each"
      const block = findBlockEnd(tmpl, re.lastIndex, type)
      if (!block) {
        last = re.lastIndex
        continue
      }
      const innerStart = re.lastIndex
      if (type === "if") {
        const truthyPart =
          block.elseAt !== null ? tmpl.slice(innerStart, block.elseAt) : tmpl.slice(innerStart, block.closeStart)
        const falsyPart =
          block.elseAt !== null ? tmpl.slice(tmpl.indexOf("}}", block.elseAt) + 2, block.closeStart) : ""
        out += truthy(lookup(scope, name)) ? render(truthyPart, scope) : render(falsyPart, scope)
      } else {
        const inner = tmpl.slice(innerStart, block.closeStart)
        const list = lookup(scope, name)
        if (Array.isArray(list)) {
          for (const item of list) {
            const childScope: ContractVars =
              item && typeof item === "object" ? { ...scope, ...item, __this: item } : { ...scope, __this: item }
            out += render(inner, childScope)
          }
        }
      }
      re.lastIndex = block.closeEnd
      last = block.closeEnd
      continue
    }

    last = re.lastIndex
  }
  out += tmpl.slice(last)
  return out
}

/** Render a template string against a flat variable map. */
export function renderContractTemplate(text: string | null | undefined, vars: ContractVars): string {
  if (!text) return ""
  return render(text, vars || {})
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export type TemplateValidation = {
  valid: boolean
  referenced: string[]
  unknownVariables: string[]
  unbalancedBlocks: string[]
  errors: string[]
}

function blockBalance(text: string): string[] {
  const problems: string[] = []
  for (const [open, close, label] of [
    [/\{\{\s*#if\b/g, /\{\{\s*\/if\s*\}\}/g, "#if / /if"],
    [/\{\{\s*#each\b/g, /\{\{\s*\/each\s*\}\}/g, "#each / /each"],
  ] as [RegExp, RegExp, string][]) {
    const opens = (text.match(open) || []).length
    const closes = (text.match(close) || []).length
    if (opens !== closes) problems.push(`${label} (${opens} open, ${closes} close)`)
  }
  return problems
}

/**
 * Validate a template's content against the variable catalog for its source.
 * Unknown variables are those not resolvable from the base + source catalog
 * (falling back to the union of all sources so cross-source tokens don't error).
 */
export function validateTemplate(input: { content?: string | null; source?: string | null }): TemplateValidation {
  const referenced = extractVariables(input.content)
  const catalog = new Set(variablesForSource(input.source).map((v) => v.token))
  const universe = allKnownTokens()
  const unknownVariables = referenced
    .map((r) => r.split(".")[0])
    .filter((base, i, arr) => arr.indexOf(base) === i)
    .filter((base) => !catalog.has(base) && !universe.has(base))
  const unbalancedBlocks = blockBalance(input.content || "")
  const errors: string[] = []
  if (!String(input.content || "").trim()) errors.push("Content is required")
  if (unbalancedBlocks.length) errors.push(`Unbalanced blocks: ${unbalancedBlocks.join(", ")}`)
  return { valid: errors.length === 0, referenced, unknownVariables, unbalancedBlocks, errors }
}

/** Variables that resolve to empty in the given map (from a required list). */
export function missingRequiredValues(
  requiredVariables: string[] | null | undefined,
  vars: ContractVars,
): string[] {
  if (!requiredVariables?.length) return []
  return requiredVariables.filter((token) => {
    const base = token.split(".")[0]
    const v = lookup(vars, token) ?? (vars as any)[base]
    return v == null || String(v).trim() === ""
  })
}

/** True if rendered content still contains any {{token}} placeholders. */
export function hasUnresolvedTokens(text: string | null | undefined): boolean {
  if (!text) return false
  return /\{\{\s*[\w.$#/]+.*?\}\}/.test(text)
}
