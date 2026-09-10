import "server-only"
import { getSettings } from "@/lib/settings/server"
import { nextRecordId } from "@/lib/record-ids"

/**
 * Settings-driven document numbering. Each document kind maps to the settings
 * keys that control its prefix and (optionally) digit count, falling back to the
 * previous hardcoded values when a setting is missing.
 */
const DOC_CONFIG: Record<string, { prefixKey: string; digitsKey?: string; fallbackPrefix: string; fallbackDigits: number }> = {
  invoice: { prefixKey: "finance.invoice_prefix", digitsKey: "finance.invoice_digits", fallbackPrefix: "INV", fallbackDigits: 4 },
  estimate: { prefixKey: "finance.estimate_prefix", fallbackPrefix: "EST", fallbackDigits: 4 },
  payment: { prefixKey: "finance.payment_prefix", fallbackPrefix: "PMT", fallbackDigits: 4 },
  contract: { prefixKey: "contract.prefix", digitsKey: "contract.digits", fallbackPrefix: "CON", fallbackDigits: 4 },
  ticket: { prefixKey: "ticket.prefix", fallbackPrefix: "TKT", fallbackDigits: 4 },
  project: { prefixKey: "project.prefix", fallbackPrefix: "PRJ", fallbackDigits: 4 },
  asset: { prefixKey: "asset.prefix", fallbackPrefix: "AST", fallbackDigits: 4 },
  purchase_order: { prefixKey: "purchase.po_prefix", fallbackPrefix: "PO", fallbackDigits: 4 },
  bill: { prefixKey: "purchase.bill_prefix", fallbackPrefix: "BILL", fallbackDigits: 4 },
  job: { prefixKey: "recruit.job_prefix", fallbackPrefix: "JOB", fallbackDigits: 4 },
}

export type DocumentKind = keyof typeof DOC_CONFIG

/**
 * Generates the next id for a document kind using the configured prefix/digits.
 * Custom prefixes from settings are allowed (allowCustom).
 */
export async function nextDocumentId(kind: DocumentKind): Promise<string> {
  const cfg = DOC_CONFIG[kind]
  const settings = await getSettings()
  const prefix = (settings[cfg.prefixKey] || cfg.fallbackPrefix).trim() || cfg.fallbackPrefix
  const digits = cfg.digitsKey ? Number(settings[cfg.digitsKey]) || cfg.fallbackDigits : cfg.fallbackDigits
  return nextRecordId(prefix, { digits, allowCustom: true })
}

/**
 * Maps a built-in record prefix (used by the generic config-driven CRUD
 * factories) to the settings key that can override it. Only prefixes that have
 * a corresponding Company Setting appear here; anything else keeps its default.
 */
const PREFIX_SETTING_OVERRIDES: Record<string, string> = {
  TKT: "ticket.prefix",
  PROJ: "project.prefix",
  PRJ: "project.prefix",
  INV: "finance.invoice_prefix",
  EST: "finance.estimate_prefix",
  PMT: "finance.payment_prefix",
  CONT: "contract.prefix",
  AST: "asset.prefix",
  ASM: "asset.prefix",
  PB: "purchase.bill_prefix",
}

/**
 * Like nextRecordId, but first checks whether the given built-in prefix has a
 * configured override in Company Settings. Used by the generic Support /
 * Finance / Recruitment CRUD factories so their settings-driven prefixes take
 * effect without changing each module config.
 */
export async function nextRecordIdForPrefix(prefix: string): Promise<string> {
  const settingKey = PREFIX_SETTING_OVERRIDES[prefix.toUpperCase()]
  if (settingKey) {
    const settings = await getSettings()
    const override = (settings[settingKey] || "").trim()
    if (override && override.toUpperCase() !== prefix.toUpperCase()) {
      return nextRecordId(override, { allowCustom: true })
    }
  }
  return nextRecordId(prefix)
}
