/**
 * SPEC 19 (req #74) — AI Document Intelligence: pure model & policy layer.
 * ---------------------------------------------------------------------------
 * This file has NO database, network or provider I/O so every decision it makes
 * is exhaustively unit-testable:
 *
 *   - the document vocabulary (invoice / receipt / resume / contract),
 *   - the field schema each type extracts,
 *   - a deterministic, multilingual classifier + field extractor over OCR text,
 *   - confidence + source-highlight computation,
 *   - the PROCESSING GATE (only queue after a clean malware verdict AND tenant
 *     authorization) and the POSTING GATE (never post before human review),
 *   - reviewer-correction merge, validation and status transitions.
 *
 * The service layer wires these decisions to storage, the malware scanner, the
 * DMS and the existing AI cores; it never re-implements any policy defined here.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const DOC_TYPES = ["invoice", "receipt", "resume", "contract"] as const
export type DocType = (typeof DOC_TYPES)[number]
export type ClassifiedDocType = DocType | "unknown"

export function normalizeDocType(value: unknown): ClassifiedDocType {
  return DOC_TYPES.includes(value as DocType) ? (value as DocType) : "unknown"
}

/** Where an extraction sits in its lifecycle. */
export const EXTRACTION_STATUSES = [
  "uploaded", // file stored; malware scan pending
  "queued", // passed malware + tenant-authorization gate; awaiting processing
  "processing", // extractor running
  "extracted", // fields extracted; awaiting human review
  "reviewed", // a reviewer approved (with any corrections) — ready to post
  "posted", // a record was created from the reviewed extraction
  "rejected", // a reviewer discarded the extraction
  "failed", // extraction errored
] as const
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number]

export function normalizeStatus(value: unknown): ExtractionStatus {
  return EXTRACTION_STATUSES.includes(value as ExtractionStatus)
    ? (value as ExtractionStatus)
    : "uploaded"
}

// ---------------------------------------------------------------------------
// Field schema
// ---------------------------------------------------------------------------

export type FieldType = "string" | "number" | "currency" | "date" | "email" | "phone"

export type FieldDef = {
  key: string
  label: string
  type: FieldType
  required: boolean
  /** Case-insensitive label synonyms across languages used to locate the value. */
  synonyms: string[]
}

/**
 * Per-type field schema. Synonyms are deliberately multilingual (English /
 * French / German / Spanish / Hindi transliteration / CJK) so a scan in another
 * language still resolves the same canonical field key.
 */
export const FIELD_SCHEMAS: Record<DocType, FieldDef[]> = {
  invoice: [
    { key: "invoice_number", label: "Invoice number", type: "string", required: true, synonyms: ["invoice number", "invoice no", "invoice #", "facture", "rechnung nr", "factura", "número de factura", "请求书番号", "发票号码", "बिल संख्या"] },
    { key: "invoice_date", label: "Invoice date", type: "date", required: true, synonyms: ["invoice date", "date", "date de facture", "rechnungsdatum", "fecha", "発行日", "开票日期", "दिनांक"] },
    { key: "due_date", label: "Due date", type: "date", required: false, synonyms: ["due date", "payment due", "échéance", "fällig am", "vencimiento", "支払期限", "到期日"] },
    { key: "vendor_name", label: "Vendor", type: "string", required: false, synonyms: ["vendor", "supplier", "from", "bill from", "fournisseur", "lieferant", "proveedor", "供应商"] },
    { key: "total_amount", label: "Total amount", type: "currency", required: true, synonyms: ["total", "amount due", "grand total", "total ttc", "gesamt", "importe total", "合計", "总计", "कुल"] },
    { key: "tax_amount", label: "Tax", type: "currency", required: false, synonyms: ["tax", "vat", "gst", "tva", "mwst", "iva", "消費税", "税额"] },
    { key: "currency", label: "Currency", type: "string", required: false, synonyms: ["currency", "devise", "währung", "moneda", "通貨"] },
  ],
  receipt: [
    { key: "merchant_name", label: "Merchant", type: "string", required: true, synonyms: ["merchant", "store", "sold by", "commerçant", "händler", "comercio", "店舗", "商家"] },
    { key: "receipt_date", label: "Date", type: "date", required: true, synonyms: ["date", "purchased", "date d'achat", "kaufdatum", "fecha", "購入日", "日期"] },
    { key: "total_amount", label: "Total", type: "currency", required: true, synonyms: ["total", "amount", "total ttc", "gesamt", "importe", "合計", "总额", "कुल"] },
    { key: "tax_amount", label: "Tax", type: "currency", required: false, synonyms: ["tax", "vat", "gst", "tva", "mwst", "iva", "税"] },
    { key: "payment_method", label: "Payment method", type: "string", required: false, synonyms: ["payment method", "paid by", "card", "mode de paiement", "zahlungsart", "método de pago", "支払方法"] },
  ],
  resume: [
    { key: "full_name", label: "Full name", type: "string", required: true, synonyms: ["name", "full name", "nom", "name:", "nombre", "氏名", "姓名", "नाम"] },
    { key: "email", label: "Email", type: "email", required: true, synonyms: ["email", "e-mail", "courriel", "correo", "メール", "邮箱"] },
    { key: "phone", label: "Phone", type: "phone", required: false, synonyms: ["phone", "mobile", "tel", "téléphone", "telefon", "teléfono", "電話", "电话", "फ़ोन"] },
    { key: "current_title", label: "Current title", type: "string", required: false, synonyms: ["title", "role", "position", "poste", "puesto", "職種", "职位"] },
    { key: "years_experience", label: "Years of experience", type: "number", required: false, synonyms: ["experience", "years of experience", "expérience", "erfahrung", "experiencia", "経験年数"] },
  ],
  contract: [
    { key: "contract_title", label: "Contract title", type: "string", required: true, synonyms: ["agreement", "contract", "title", "contrat", "vertrag", "contrato", "契約", "合同"] },
    { key: "party_one", label: "Party 1", type: "string", required: true, synonyms: ["party", "between", "party a", "entre", "partei", "parte", "甲方", "पक्ष"] },
    { key: "party_two", label: "Party 2", type: "string", required: false, synonyms: ["and", "party b", "counterparty", "et", "und", "y", "乙方"] },
    { key: "effective_date", label: "Effective date", type: "date", required: true, synonyms: ["effective date", "start date", "date d'effet", "gültig ab", "fecha de vigencia", "発効日", "生效日期"] },
    { key: "term_end_date", label: "End date", type: "date", required: false, synonyms: ["end date", "expiry", "termination date", "date de fin", "enddatum", "fecha de finalización", "終了日", "终止日期"] },
    { key: "contract_value", label: "Contract value", type: "currency", required: false, synonyms: ["value", "contract value", "amount", "montant", "vertragswert", "valor", "契約金額", "合同金额"] },
  ],
}

export function fieldSchemaFor(docType: ClassifiedDocType): FieldDef[] {
  return docType === "unknown" ? [] : FIELD_SCHEMAS[docType]
}

// ---------------------------------------------------------------------------
// Extracted field shape
// ---------------------------------------------------------------------------

/** Where in the source text a value was found — drives the UI source highlight. */
export type SourceHighlight = {
  /** 0-based line index within the normalized text. */
  line: number
  /** Character offsets within the whole normalized text. */
  start: number
  end: number
  /** The exact matched snippet (already length-bounded). */
  snippet: string
}

export type ExtractedField = {
  key: string
  label: string
  type: FieldType
  /** null when the field could not be located. */
  value: string | null
  /** 0..1 confidence for this specific field. */
  confidence: number
  required: boolean
  source: SourceHighlight | null
  /** True once a reviewer changed the value from the model output. */
  corrected: boolean
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/**
 * Normalize OCR text into stable lines with known character offsets. Collapses
 * CRLF, trims trailing spaces and drops a UTF-8 BOM but preserves unicode so
 * multilingual content survives intact.
 */
export function normalizeText(raw: string): { text: string; lines: string[]; lineOffsets: number[] } {
  const cleaned = (raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  const lines = cleaned.split("\n").map((l) => l.replace(/[ \t]+$/g, ""))
  const text = lines.join("\n")
  const lineOffsets: number[] = []
  let offset = 0
  for (const line of lines) {
    lineOffsets.push(offset)
    offset += line.length + 1 // +1 for the newline
  }
  return { text, lines, lineOffsets }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const CLASSIFIER_SIGNALS: Record<DocType, string[]> = {
  invoice: ["invoice", "facture", "rechnung", "factura", "请求书", "发票", "tax invoice", "bill to", "invoice number", "amount due"],
  receipt: ["receipt", "reçu", "quittung", "recibo", "領収書", "收据", "cash", "change", "thank you for your purchase", "merchant"],
  resume: ["resume", "curriculum vitae", "cv", "work experience", "education", "skills", "lebenslauf", "履歴書", "简历", "professional summary"],
  contract: ["agreement", "contract", "hereby", "party of the first part", "vertrag", "contrat", "contrato", "契約", "合同", "terms and conditions", "witnesseth"],
}

export type Classification = {
  docType: ClassifiedDocType
  confidence: number
  scores: Record<DocType, number>
}

/**
 * Heuristic, deterministic classifier. Scores each type by how many of its
 * signal phrases appear (case-insensitive, unicode-safe). The winning type's
 * confidence is its share of total signal hits, so an ambiguous document scores
 * low and a clear one scores high. Ties and empty text resolve to "unknown".
 */
export function classifyDocument(raw: string, hint?: ClassifiedDocType | null): Classification {
  const hay = (raw ?? "").toLowerCase()
  const scores = { invoice: 0, receipt: 0, resume: 0, contract: 0 } as Record<DocType, number>
  for (const type of DOC_TYPES) {
    for (const sig of CLASSIFIER_SIGNALS[type]) {
      if (hay.includes(sig.toLowerCase())) scores[type] += 1
    }
  }
  // A valid caller hint nudges its type so a borderline scan classifies as asked.
  if (hint && hint !== "unknown") scores[hint] += 1

  const total = DOC_TYPES.reduce((sum, t) => sum + scores[t], 0)
  if (total === 0) return { docType: "unknown", confidence: 0, scores }

  let best: DocType = "invoice"
  let bestScore = -1
  let tie = false
  for (const t of DOC_TYPES) {
    if (scores[t] > bestScore) {
      best = t
      bestScore = scores[t]
      tie = false
    } else if (scores[t] === bestScore) {
      tie = true
    }
  }
  if (bestScore <= 0 || tie) return { docType: "unknown", confidence: 0, scores }
  return { docType: best, confidence: round2(bestScore / total), scores }
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

const AMOUNT_RE = /(?:[$€£¥₹]|USD|EUR|GBP|INR|JPY|CNY)?\s*-?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?\s*(?:[$€£¥₹]|USD|EUR|GBP|INR|JPY|CNY)?/i
const DATE_RE = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}\s+[A-Za-zÀ-ÿ]{3,}\.?\s+\d{2,4}/
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/

function valuePatternFor(type: FieldType): RegExp {
  switch (type) {
    case "currency":
      return AMOUNT_RE
    case "number":
      return /-?\d+(?:[.,]\d+)?/
    case "date":
      return DATE_RE
    case "email":
      return EMAIL_RE
    case "phone":
      return PHONE_RE
    default:
      return /.+/
  }
}

/**
 * Locate a single field in the normalized text. Looks for any of the field's
 * label synonyms and captures the value to its right (same line) or, failing
 * that, scans the whole document for a type-appropriate pattern (email/phone).
 */
function extractField(
  def: FieldDef,
  norm: { text: string; lines: string[]; lineOffsets: number[] },
): ExtractedField {
  const pattern = valuePatternFor(def.type)
  // 1) Label-anchored: "<synonym> : <value>" on the same line.
  for (let i = 0; i < norm.lines.length; i++) {
    const line = norm.lines[i]
    const lower = line.toLowerCase()
    for (const syn of def.synonyms) {
      const idx = lower.indexOf(syn.toLowerCase())
      if (idx === -1) continue
      const after = line.slice(idx + syn.length).replace(/^[\s:：=\-–]+/, "")
      const m = def.type === "string" ? sliceString(after) : after.match(pattern)
      const rawVal = def.type === "string" ? (m as string | null) : m?.[0] ?? null
      if (rawVal && rawVal.trim()) {
        const value = normalizeValue(def.type, rawVal.trim())
        const valueStartInLine = m && typeof m !== "string" && m.index != null
          ? idx + syn.length + (line.slice(idx + syn.length).length - after.length) + m.index
          : idx + syn.length
        const start = norm.lineOffsets[i] + Math.max(0, valueStartInLine)
        const snippet = line.trim().slice(0, 160)
        return {
          key: def.key,
          label: def.label,
          type: def.type,
          value,
          confidence: def.type === "string" ? 0.75 : 0.9,
          required: def.required,
          source: { line: i, start, end: start + rawVal.trim().length, snippet },
          corrected: false,
        }
      }
    }
  }
  // 2) Pattern-only fallback for strongly-typed fields (email/phone/date).
  if (def.type === "email" || def.type === "phone" || def.type === "date") {
    const m = norm.text.match(pattern)
    if (m && m.index != null) {
      const line = lineOfOffset(m.index, norm.lineOffsets)
      return {
        key: def.key,
        label: def.label,
        type: def.type,
        value: normalizeValue(def.type, m[0].trim()),
        confidence: 0.6,
        required: def.required,
        source: { line, start: m.index, end: m.index + m[0].length, snippet: (norm.lines[line] ?? "").trim().slice(0, 160) },
        corrected: false,
      }
    }
  }
  return { key: def.key, label: def.label, type: def.type, value: null, confidence: 0, required: def.required, source: null, corrected: false }
}

function sliceString(after: string): string | null {
  const v = after.split(/\s{2,}|\t|\||;/)[0]?.trim() ?? ""
  return v.length ? v.slice(0, 120) : null
}

function lineOfOffset(offset: number, lineOffsets: number[]): number {
  let line = 0
  for (let i = 0; i < lineOffsets.length; i++) {
    if (lineOffsets[i] <= offset) line = i
    else break
  }
  return line
}

/** Light per-type value normalization (kept lossless for strings). */
export function normalizeValue(type: FieldType, raw: string): string {
  if (type === "currency") {
    // Keep the numeric magnitude but strip stray spaces around symbols.
    return raw.replace(/\s+/g, " ").trim()
  }
  if (type === "number") {
    const n = raw.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}\b)/g, "")
    return n
  }
  if (type === "email") return raw.toLowerCase()
  return raw
}

export type ExtractionModel = {
  docType: ClassifiedDocType
  classification: Classification
  fields: ExtractedField[]
  overallConfidence: number
}

/**
 * Full deterministic extraction over OCR text: classify (unless a valid type is
 * forced), then extract every field in that type's schema. Returns the fields
 * with per-field confidence + source highlights and a blended overall score.
 */
export function extractDocument(raw: string, forcedType?: ClassifiedDocType | null): ExtractionModel {
  const norm = normalizeText(raw)
  const classification = classifyDocument(raw, forcedType)
  const docType = forcedType && forcedType !== "unknown" ? forcedType : classification.docType
  const defs = fieldSchemaFor(docType)
  const fields = defs.map((d) => extractField(d, norm))
  return { docType, classification, fields, overallConfidence: computeOverallConfidence(fields, classification.confidence) }
}

/**
 * Blend field confidences with the classifier confidence. Required fields are
 * weighted double so a missing required field drags the score down hard.
 */
export function computeOverallConfidence(fields: ExtractedField[], classifierConfidence = 1): number {
  if (fields.length === 0) return 0
  let weighted = 0
  let weight = 0
  for (const f of fields) {
    const w = f.required ? 2 : 1
    weighted += f.confidence * w
    weight += w
  }
  const fieldScore = weight === 0 ? 0 : weighted / weight
  return round2(0.3 * classifierConfidence + 0.7 * fieldScore)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationResult = { valid: boolean; errors: string[] }

const AMOUNT_VALIDATE = /\d/
const DATE_VALIDATE = /\d{1,4}[-/.\s]\d{1,2}|\d{1,2}\s+[A-Za-zÀ-ÿ]{3,}/

/** Validate the final field set for a doc type: required present + type-shaped. */
export function validateExtraction(docType: ClassifiedDocType, fields: ExtractedField[]): ValidationResult {
  const errors: string[] = []
  if (docType === "unknown") errors.push("Document type could not be determined")
  const byKey = new Map(fields.map((f) => [f.key, f]))
  for (const def of fieldSchemaFor(docType)) {
    const f = byKey.get(def.key)
    const value = f?.value?.trim() ?? ""
    if (def.required && !value) {
      errors.push(`Missing required field: ${def.label}`)
      continue
    }
    if (!value) continue
    if (def.type === "email" && !EMAIL_RE.test(value)) errors.push(`Invalid email: ${def.label}`)
    if (def.type === "currency" && !AMOUNT_VALIDATE.test(value)) errors.push(`Invalid amount: ${def.label}`)
    if (def.type === "number" && !/^-?\d+(?:[.,]\d+)?$/.test(value)) errors.push(`Invalid number: ${def.label}`)
    if (def.type === "date" && !DATE_VALIDATE.test(value)) errors.push(`Invalid date: ${def.label}`)
  }
  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Reviewer corrections
// ---------------------------------------------------------------------------

export type FieldCorrection = { key: string; value: string | null }

/**
 * Apply a reviewer's corrections onto the extracted fields, producing the final
 * field set. A corrected field is flagged, gets full confidence and its source
 * highlight is cleared (the value no longer comes from the model). Unknown keys
 * are ignored so a forged correction can't inject arbitrary fields.
 */
export function mergeCorrections(fields: ExtractedField[], corrections: FieldCorrection[]): ExtractedField[] {
  const patch = new Map(corrections.map((c) => [c.key, c.value]))
  return fields.map((f) => {
    if (!patch.has(f.key)) return f
    const next = patch.get(f.key) ?? null
    const nextValue = next == null ? null : String(next).trim()
    const changed = (nextValue || null) !== (f.value || null)
    if (!changed) return f
    return { ...f, value: nextValue || null, confidence: nextValue ? 1 : 0, corrected: true, source: null }
  })
}

/** The subset of fields a reviewer actually changed (for the audit trail). */
export function diffCorrections(before: ExtractedField[], after: ExtractedField[]): FieldCorrection[] {
  const beforeByKey = new Map(before.map((f) => [f.key, f.value ?? null]))
  const out: FieldCorrection[] = []
  for (const f of after) {
    const prev = beforeByKey.get(f.key) ?? null
    if ((f.value ?? null) !== prev) out.push({ key: f.key, value: f.value ?? null })
  }
  return out
}

// ---------------------------------------------------------------------------
// Gates (the security-critical decisions)
// ---------------------------------------------------------------------------

export type GateDecision = { allowed: true } | { allowed: false; reason: string }

/**
 * PROCESSING GATE — an extraction may only be queued for processing once the
 * raw document has a clean malware verdict (or an explicit admin release) AND
 * the tenant is authorized to run document intelligence. Fail-closed: anything
 * other than a proven-safe, authorized state is rejected. Mirrors the malware
 * download-gate semantics (infected is terminal; pending/scanning/error hold).
 */
export function canQueueForProcessing(input: {
  scanStatus: "pending" | "scanning" | "clean" | "infected" | "error" | null
  approved: boolean
  tenantAuthorized: boolean
}): GateDecision {
  if (!input.tenantAuthorized) return { allowed: false, reason: "Document intelligence is not enabled for this organisation" }
  if (input.scanStatus === "infected") return { allowed: false, reason: "File is infected and can never be processed" }
  if (input.scanStatus === "clean") return { allowed: true }
  if (input.approved) return { allowed: true } // admin released an uncertain verdict
  if (input.scanStatus == null || input.scanStatus === "pending" || input.scanStatus === "scanning") {
    return { allowed: false, reason: "Awaiting malware scan before processing" }
  }
  return { allowed: false, reason: "Malware scan did not complete; processing is held" }
}

/**
 * POSTING GATE — a record may only be created from an extraction after a human
 * reviewed it AND validation passes. Never post an unreviewed or invalid
 * extraction, and never post the same extraction twice.
 */
export function canPost(input: {
  status: ExtractionStatus
  validation: ValidationResult
}): GateDecision {
  if (input.status === "posted") return { allowed: false, reason: "This extraction has already been posted" }
  if (input.status !== "reviewed") return { allowed: false, reason: "The extraction must be reviewed before posting" }
  if (!input.validation.valid) return { allowed: false, reason: `Validation failed: ${input.validation.errors.join("; ")}` }
  return { allowed: true }
}

/** Legal status transitions, so the store/service can reject illegal jumps. */
const TRANSITIONS: Record<ExtractionStatus, ExtractionStatus[]> = {
  uploaded: ["queued", "failed", "rejected"],
  queued: ["processing", "failed", "rejected"],
  processing: ["extracted", "failed"],
  extracted: ["reviewed", "rejected", "processing"], // re-process allowed
  reviewed: ["posted", "rejected", "extracted"], // reopen for more edits
  posted: [],
  rejected: [],
  failed: ["queued", "rejected"],
}

export function canTransition(from: ExtractionStatus, to: ExtractionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Stable content fingerprint for de-duplicating repeated uploads of the SAME
 * bytes within a tenant. Combines the tenant, the file checksum and the doc type
 * so re-uploading an identical scan maps to one logical extraction.
 */
export function deriveContentHash(input: { tenantId: number; checksum: string | null; size: number }): string {
  const basis = `${input.tenantId}:${input.checksum ?? "nochecksum"}:${input.size}`
  return simpleHash(basis)
}

/** Deterministic posting idempotency key so a retried post can't double-create. */
export function derivePostIdempotencyKey(input: { tenantId: number; extractionId: number; version: number }): string {
  return simpleHash(`post:${input.tenantId}:${input.extractionId}:${input.version}`)
}

function simpleHash(s: string): string {
  // FNV-1a 64-bit (BigInt) — dependency-free, stable across runs. Not for
  // security; only for stable de-duplication keys.
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, "0")
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
