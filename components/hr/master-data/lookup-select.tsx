"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Input } from "@/components/ui/input"
import { ChevronsUpDown, Check, X } from "lucide-react"
import { cn } from "@/lib/utils"

export type LookupKind = "employees" | "departments" | "designations" | "document-types"

type Option = { value: string; label: string; hint?: string }

function mapRows(kind: LookupKind, rows: any[]): Option[] {
  switch (kind) {
    case "employees":
      return rows.map((r) => ({
        value: String(r.id),
        label: r.employee_name,
        hint: [r.employee_id, r.designation].filter(Boolean).join(" · "),
      }))
    case "departments":
      return rows.map((r) => ({ value: r.department_id, label: r.department_name, hint: r.department_id }))
    case "designations":
      return rows.map((r) => ({
        value: r.designation_id,
        label: r.designation_name,
        hint: [r.designation_id, r.level_name].filter(Boolean).join(" · "),
      }))
    case "document-types":
      return rows.map((r) => ({ value: String(r.id), label: r.type_name }))
  }
}

/**
 * Async, searchable single-select backed by the master-data lookup API.
 * Dependency-free combobox: a trigger button + a filterable dropdown panel,
 * so no full master payload is pulled just to render a picker.
 */
export function LookupSelect({
  kind,
  value,
  onChange,
  placeholder = "Select…",
  allowClear = true,
  disabled = false,
}: {
  kind: LookupKind
  value: string | null | undefined
  onChange: (value: string | null, option: Option | null) => void
  placeholder?: string
  allowClear?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)

  const { data } = useSWR<{ rows: any[] }>(
    open || value ? `/api/hr/master-data/lookups?kind=${kind}&q=${encodeURIComponent(q)}` : null,
    fetcher,
  )
  const options = useMemo(() => mapRows(kind, data?.rows || []), [kind, data])
  const selected = options.find((o) => o.value === String(value)) || null

  // Keep a resolved label for the current value even before the list loads.
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null)
  useEffect(() => {
    if (selected) setResolvedLabel(selected.label)
    else if (!value) setResolvedLabel(null)
  }, [selected, value])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm",
          "focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value ? resolvedLabel || selected?.label || value : placeholder}
        </span>
        <span className="flex items-center gap-1">
          {allowClear && value && (
            <X
              className="size-3.5 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onChange(null, null)
                setResolvedLabel(null)
              }}
            />
          )}
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="mb-1 h-8"
          />
          <div className="max-h-56 overflow-auto">
            {options.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">No matches</p>}
            {options.map((o) => (
              <button
                type="button"
                key={o.value}
                onClick={() => {
                  onChange(o.value, o)
                  setResolvedLabel(o.label)
                  setOpen(false)
                  setQ("")
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                  o.value === String(value) && "bg-accent",
                )}
              >
                <span className="flex flex-col">
                  <span className="truncate">{o.label}</span>
                  {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
                </span>
                {o.value === String(value) && <Check className="size-3.5" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
