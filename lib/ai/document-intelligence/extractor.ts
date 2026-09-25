/**
 * SPEC 19 (req #74) — document extraction PROVIDER layer.
 * ---------------------------------------------------------------------------
 * A pluggable provider interface (mirroring the malware-scan provider pattern in
 * lib/storage/file-scanning.ts) so the deterministic built-in extractor can be
 * swapped for an AI-Gateway-backed one later without touching the service or the
 * routes. This module is pure (no DB/network) and fully unit-testable.
 */

import {
  extractDocument,
  computeOverallConfidence,
  type ClassifiedDocType,
  type ExtractedField,
} from "./model"

export type ExtractionRequest = {
  /** OCR / plain-text content of the raw document. */
  text: string
  filename: string | null
  mimeType: string | null
  /** Force a document type instead of auto-classifying (from a reviewer hint). */
  forcedType?: ClassifiedDocType | null
}

export type ExtractionResult = {
  docType: ClassifiedDocType
  fields: ExtractedField[]
  overallConfidence: number
  /** BCP-47-ish language guess for the source text. */
  language: string
  provider: string
  model: string | null
  warnings: string[]
}

export interface DocExtractionProvider {
  readonly id: string
  extract(req: ExtractionRequest): Promise<ExtractionResult>
}

/** Crude, dependency-free language guess used only for display/audit. */
export function detectLanguage(text: string): string {
  const t = text ?? ""
  if (/[\u4e00-\u9fff]/.test(t)) return "zh"
  if (/[\u3040-\u30ff]/.test(t)) return "ja"
  if (/[\uac00-\ud7af]/.test(t)) return "ko"
  if (/[\u0900-\u097f]/.test(t)) return "hi"
  if (/[\u0600-\u06ff]/.test(t)) return "ar"
  if (/[àâçéèêëîïôûùüÿœ]/i.test(t) && /\b(facture|reçu|contrat|montant|date)\b/i.test(t)) return "fr"
  if (/[äöüß]/i.test(t) && /\b(rechnung|betrag|vertrag|datum)\b/i.test(t)) return "de"
  if (/[áéíóúñ¿¡]/i.test(t) && /\b(factura|recibo|contrato|importe|fecha)\b/i.test(t)) return "es"
  return "en"
}

/**
 * Deterministic, offline extractor. Handles empty/garbage text gracefully by
 * returning zero-confidence results with a warning rather than throwing, so a
 * malformed scan surfaces as "needs review", never as a crash.
 */
export class HeuristicExtractionProvider implements DocExtractionProvider {
  readonly id = "heuristic-v1"

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const warnings: string[] = []
    const text = typeof req.text === "string" ? req.text : ""
    if (!text.trim()) warnings.push("No readable text was found in the document")

    const model = extractDocument(text, req.forcedType ?? null)
    if (model.docType === "unknown") warnings.push("Document type could not be determined with confidence")

    const missingRequired = model.fields.filter((f) => f.required && !f.value)
    if (missingRequired.length > 0) {
      warnings.push(`Could not extract required field(s): ${missingRequired.map((f) => f.label).join(", ")}`)
    }

    return {
      docType: model.docType,
      fields: model.fields,
      overallConfidence: model.overallConfidence,
      language: detectLanguage(text),
      provider: this.id,
      model: null,
      warnings,
    }
  }
}

let activeProvider: DocExtractionProvider = new HeuristicExtractionProvider()

/** Swap the active provider (e.g. an AI-Gateway extractor). Used in tests too. */
export function setDocExtractionProvider(provider: DocExtractionProvider): void {
  activeProvider = provider
}

export function getDocExtractionProvider(): DocExtractionProvider {
  return activeProvider
}

/** Re-export for callers that want the blended-confidence helper. */
export { computeOverallConfidence }
