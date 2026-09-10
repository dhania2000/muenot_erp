"use client"

import { ExcelImportButton } from "@/components/sales/excel-import-button"
import {
  IMPORT_CONFIGS,
  buildAliases,
  templateHeaders,
  templateSample,
} from "@/lib/import-configs"

/**
 * Drop-in bulk import control for any list sub-module. Give it a `moduleKey`
 * that exists in IMPORT_CONFIGS and it renders the shared "Import" + "Template"
 * buttons, wired to the generic /api/import/<key> endpoint. Renders nothing if
 * the key is unknown, so it is always safe to place next to an export button.
 */
export function ImportButton({
  moduleKey,
  onImported,
}: {
  moduleKey: string
  onImported: () => void
}) {
  const config = IMPORT_CONFIGS[moduleKey]
  if (!config) return null

  return (
    <ExcelImportButton
      endpoint={`/api/import/${moduleKey}`}
      aliases={buildAliases(config)}
      templateFilename={`${moduleKey}-import-template.xlsx`}
      templateHeaders={templateHeaders(config)}
      templateSample={templateSample(config)}
      onImported={onImported}
    />
  )
}
