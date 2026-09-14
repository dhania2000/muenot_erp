/**
 * Shared PAN (Permanent Account Number) helpers — client- and server-safe.
 *
 * A PAN is 10 characters: five letters, four digits, one letter (AAAAA9999A).
 * The 4th character encodes the holder type (P=Individual, C=Company,
 * F=Firm/LLP, H=HUF, A=AOP, T=Trust, …) which lets us derive the TDS deductee
 * entity type straight from a valid PAN — the same taxonomy the TDS Rule Master
 * keys its rates on. Everything here is pure so it can run in a form field or in
 * the filing engine without divergence.
 */

import type { TdsEntityType } from "@/lib/finance-tds-rules"

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

export type PanStatus = "Valid" | "Invalid" | "Missing"

/** Uppercase + strip spaces so "abcpd 1234 f" → "ABCPD1234F". */
export function normalizePan(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .toUpperCase()
}

/** True only for a structurally valid 10-char PAN. */
export function isValidPan(value: unknown): boolean {
  return PAN_RE.test(normalizePan(value))
}

/** Missing when blank, else Valid / Invalid by structure. */
export function panStatus(value: unknown): PanStatus {
  const pan = normalizePan(value)
  if (!pan) return "Missing"
  return PAN_RE.test(pan) ? "Valid" : "Invalid"
}

/**
 * Whether the higher "no-PAN" TDS rate (usually 20% u/s 206AA) must apply.
 * True when the PAN is absent OR structurally invalid — both are treated by the
 * Act as "PAN not furnished".
 */
export function requiresNoPanRate(value: unknown): boolean {
  return panStatus(value) !== "Valid"
}

/** Map the 4th character of a valid PAN to a TDS deductee entity type. */
export function entityTypeForPan(value: unknown): TdsEntityType {
  const pan = normalizePan(value)
  if (!PAN_RE.test(pan)) return "Any"
  switch (pan[3]) {
    case "P":
    case "H":
      return "Individual/HUF"
    case "C":
      return "Company"
    case "F":
      return "Firm"
    default:
      return "Any"
  }
}
