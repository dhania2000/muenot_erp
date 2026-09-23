/**
 * Enterprise Data Import catalog.
 * ---------------------------------------------------------------------------
 * The registry of what a tenant admin may import. Rather than restate every
 * table + column, this DERIVES the importable datasets from the existing
 * IMPORT_CONFIGS single source of truth (the same configs that power the
 * per-list "Import" buttons), so the Import Center and the module screens can
 * never drift apart.
 *
 * Two responsibilities live here, both DB-free (no `server-only`):
 *   1. Public projection — the client-safe dataset + column metadata the
 *      mapping UI renders (labels, types, requiredness, sample values). Physical
 *      table names are NOT projected; the store resolves those server-side.
 *   2. Dedupe-key resolution — which target columns form a row's natural key
 *      for duplicate detection.
 */

import { IMPORT_CONFIGS, type ImportConfig, type ImportColumnType } from "@/lib/import-configs"
import type { ImportColumnMeta } from "@/lib/data-import-model"

/**
 * Keys whose insertion requires a bespoke, authoritative pipeline (master
 * resolution, server-side money recompute, business-id minting, duplicate
 * fingerprinting) that a generic row insert cannot faithfully reproduce — see
 * lib/finance-import-augment.ts. They keep their dedicated import dialogs and
 * are intentionally excluded from the generic Import Center so a spreadsheet
 * row can never land as a malformed financial record.
 */
export const EXCLUDED_IMPORT_KEYS = new Set<string>(["finance-expenses"])

/** Human module grouping derived from the config-key prefix. */
const MODULE_LABELS: Record<string, string> = {
  sales: "Sales",
  hr: "HR",
  finance: "Finance",
  recruit: "Recruitment",
  operations: "Operations",
  clients: "CRM",
}

function titleCase(segment: string): string {
  return segment
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function deriveModule(key: string): string {
  const prefix = key.includes("-") ? key.slice(0, key.indexOf("-")) : key
  return MODULE_LABELS[prefix] ?? titleCase(prefix)
}

function deriveLabel(key: string): string {
  const rest = key.includes("-") ? key.slice(key.indexOf("-") + 1) : key
  return titleCase(rest)
}

// ---------------------------------------------------------------------------
// Dedupe keys
// ---------------------------------------------------------------------------

/**
 * The target columns that form a row's natural key for duplicate detection.
 * Defaults to the config's required columns (a stable natural key across every
 * module) — the store further narrows this to columns that actually exist in
 * the live table before querying.
 */
export function dedupeKeysFor(config: ImportConfig): string[] {
  return config.columns.filter((c) => c.required).map((c) => c.key)
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

export type PublicImportColumn = ImportColumnMeta & { sample: string }

export type PublicImportDataset = {
  key: string
  module: string
  label: string
  columns: PublicImportColumn[]
  dedupeKeys: string[]
}

function columnType(type: ImportColumnType | undefined): ImportColumnType {
  return type ?? "string"
}

function projectDataset(key: string, config: ImportConfig): PublicImportDataset {
  return {
    key,
    module: deriveModule(key),
    label: deriveLabel(key),
    columns: config.columns.map((c) => ({
      key: c.key,
      label: c.label,
      type: columnType(c.type),
      required: Boolean(c.required),
      sample: c.sample != null ? String(c.sample) : "",
    })),
    dedupeKeys: dedupeKeysFor(config),
  }
}

/** Whether a dataset key is importable through the generic Import Center. */
export function isImportableDataset(key: string): boolean {
  return !EXCLUDED_IMPORT_KEYS.has(key) && Boolean(IMPORT_CONFIGS[key])
}

/** Resolve the underlying (server) import config for an allowed dataset key. */
export function getImportDataset(key: string): ImportConfig | undefined {
  if (!isImportableDataset(key)) return undefined
  return IMPORT_CONFIGS[key]
}

/** Client-safe catalog, sorted by module then label. */
export function importCatalogForClient(): PublicImportDataset[] {
  return Object.entries(IMPORT_CONFIGS)
    .filter(([key]) => isImportableDataset(key))
    .map(([key, config]) => projectDataset(key, config))
    .sort((a, b) => a.module.localeCompare(b.module) || a.label.localeCompare(b.label))
}

export function getPublicImportDataset(key: string): PublicImportDataset | undefined {
  const config = getImportDataset(key)
  return config ? projectDataset(key, config) : undefined
}
