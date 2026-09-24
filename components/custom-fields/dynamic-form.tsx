"use client"

import { useMemo } from "react"
import type { FieldDefinition } from "@/lib/custom-fields/model"
import { canEditField, evaluateFormula, extractFormulaRefs, numericValueOf } from "@/lib/custom-fields/model"
import type { TenantRole } from "@/lib/role-model"
import { DynamicField } from "./dynamic-field"

export type DynamicFormValues = Record<string, unknown>

/**
 * Renders a whole record's editable custom fields from their definitions, for a
 * given viewer role. Fields the role cannot edit render disabled; formula fields
 * are recomputed live on the client from the current values so the author sees
 * the same result the server will store — the reporting number, previewed.
 */
export function DynamicForm({
  defs,
  values,
  role,
  errors,
  onChange,
}: {
  defs: FieldDefinition[]
  values: DynamicFormValues
  role: TenantRole
  errors?: Record<string, string>
  onChange: (key: string, value: unknown) => void
}) {
  const ordered = useMemo(
    () => [...defs].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)),
    [defs],
  )

  // Recompute every formula from the current numeric operands, mirroring the
  // server's computeFormulas so the preview matches what will be persisted.
  const computed = useMemo(() => {
    const numeric: Record<string, number> = {}
    for (const d of defs) {
      if (d.type === "formula") continue
      numeric[d.key] = numericValueOf(d, values[d.key])
    }
    const out: Record<string, number | null> = {}
    for (const d of defs) {
      if (d.type !== "formula") continue
      const formula = d.config.formula ?? ""
      // A formula that points at a field the viewer cannot see resolves those
      // operands to 0, exactly like the server.
      void extractFormulaRefs(formula)
      const result = evaluateFormula(formula, numeric)
      out[d.key] = result == null ? null : result
    }
    return out
  }, [defs, values])

  if (ordered.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        No fields are visible to this role.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {ordered.map((def) => (
        <DynamicField
          key={def.key}
          def={def}
          value={values[def.key]}
          error={errors?.[def.key] ?? null}
          disabled={!canEditField(def, role)}
          computedValue={def.type === "formula" ? computed[def.key] ?? null : undefined}
          onChange={(v) => onChange(def.key, v)}
        />
      ))}
    </div>
  )
}
