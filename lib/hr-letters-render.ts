// ---------------------------------------------------------------------------
// HR Letters — rendering + validation engine (pure, client-safe).
//
// A small Handlebars-like template engine tailored to letter bodies:
//   - {{ token }} / {{ a.b }}      variable substitution
//   - {{#if token}}…{{else}}…{{/if}}   conditional sections
//   - {{#each list}}…{{/each}}     iteration (uses {{this}} / {{prop}} inside)
//
// It has NO server-only imports so the template console, editor and generate
// wizard can render a live preview in the browser with the exact same output
// the server produces when the letter is generated.
// ---------------------------------------------------------------------------

import { variablesForEvent, extractVariables } from "@/lib/hr-letters-shared"

export type LetterVars = Record<string, unknown>

const TAG_RE = /\{\{\s*(#if|#each|else|\/if|\/each)?\s*([\w.$]*)\s*\}\}/g

function lookup(scope: LetterVars, path: string): unknown {
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

/** Find the index where the block opened at `from` closes, honoring nesting. */
function findBlockEnd(tmpl: string, from: number, tag: "if" | "each"): { elseAt: number | null; closeStart: number; closeEnd: number } | null {
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

function render(tmpl: string, scope: LetterVars): string {
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
        // Unbalanced — emit nothing further for this tag and stop.
        last = re.lastIndex
        continue
      }
      const innerStart = re.lastIndex
      if (type === "if") {
        const truthyPart =
          block.elseAt !== null ? tmpl.slice(innerStart, block.elseAt) : tmpl.slice(innerStart, block.closeStart)
        const falsyPart =
          block.elseAt !== null
            ? tmpl.slice(tmpl.indexOf("}}", block.elseAt) + 2, block.closeStart)
            : ""
        out += truthy(lookup(scope, name)) ? render(truthyPart, scope) : render(falsyPart, scope)
      } else {
        const inner = tmpl.slice(innerStart, block.closeStart)
        const list = lookup(scope, name)
        if (Array.isArray(list)) {
          for (const item of list) {
            const childScope: LetterVars =
              item && typeof item === "object" ? { ...scope, ...item, __this: item } : { ...scope, __this: item }
            out += render(inner, childScope)
          }
        }
      }
      re.lastIndex = block.closeEnd
      last = block.closeEnd
      continue
    }

    // Stray else / closers at top level — skip the tag text.
    last = re.lastIndex
  }
  out += tmpl.slice(last)
  return out
}

/** Render a template string against a flat variable map. Returns plain text. */
export function renderLetterTemplate(text: string | null | undefined, vars: LetterVars): string {
  if (!text) return ""
  return render(text, vars || {})
}

/** Escape + convert a rendered plain-text letter into safe HTML (for email). */
export function letterTextToHtml(text: string): string {
  const escaped = (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("")
  return `<div style="font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.7;color:#1f2937">${paragraphs}</div>`
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

/** Count block open/close balance for #if and #each. */
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
 * Validate a template body/subject against the variable catalog for its event.
 * Unknown variables are those not resolvable from the base + event catalog.
 */
export function validateTemplate(input: {
  subject?: string | null
  body?: string | null
  eventKey?: string | null
}): TemplateValidation {
  const referenced = extractVariables(input.subject, input.body)
  const catalog = new Set(variablesForEvent(input.eventKey).map((v) => v.token))
  const unknownVariables = referenced
    .map((r) => r.split(".")[0])
    .filter((base, i, arr) => arr.indexOf(base) === i)
    .filter((base) => !catalog.has(base))
  const unbalancedBlocks = [
    ...blockBalance(input.subject || ""),
    ...blockBalance(input.body || ""),
  ]
  const errors: string[] = []
  if (!String(input.subject || "").trim()) errors.push("Subject is required")
  if (!String(input.body || "").trim()) errors.push("Body is required")
  if (unbalancedBlocks.length) errors.push(`Unbalanced blocks: ${unbalancedBlocks.join(", ")}`)
  return {
    valid: errors.length === 0,
    referenced,
    unknownVariables,
    unbalancedBlocks,
    errors,
  }
}

/** Variables referenced by a template that resolve to empty in the given map. */
export function missingRequiredValues(
  requiredVariables: string[] | null | undefined,
  vars: LetterVars,
): string[] {
  if (!requiredVariables?.length) return []
  return requiredVariables.filter((token) => {
    const v = lookup(vars, token)
    return v == null || String(v).trim() === ""
  })
}
