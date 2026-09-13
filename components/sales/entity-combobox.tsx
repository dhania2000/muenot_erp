"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronsUpDown, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

export type ComboOption = {
  value: string
  label: string
  hint?: string | null
}

/**
 * Lightweight searchable single-select. Used for relational pickers
 * (company / contract / quotation / lead / contact / owner) where the option
 * lists can be large. Purely client-side UX — the server re-resolves and
 * validates every relation on save.
 */
export function EntityCombobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  emptyText = "No matches",
  disabled,
  allowClear = true,
  id,
}: {
  options: ComboOption[]
  value: string | null
  onChange: (value: string | null) => void
  placeholder?: string
  emptyText?: string
  disabled?: boolean
  allowClear?: boolean
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(() => options.find((o) => o.value === value) || null, [options, value])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options.slice(0, 100)
    return options
      .filter((o) => o.label.toLowerCase().includes(q) || (o.hint || "").toLowerCase().includes(q))
      .slice(0, 100)
  }, [options, query])

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
          !selected && "text-muted-foreground",
        )}
      >
        <span className="line-clamp-1 text-left">{selected ? selected.label : placeholder}</span>
        <span className="flex items-center gap-1">
          {selected && allowClear && !disabled && (
            <X
              className="size-3.5 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onChange(null)
              }}
            />
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
          <div className="border-b border-border p-1.5">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="h-7"
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
            )}
            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                  setQuery("")
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                  o.value === value && "bg-accent/50",
                )}
              >
                <span className="flex flex-col">
                  <span className="line-clamp-1">{o.label}</span>
                  {o.hint && <span className="line-clamp-1 text-xs text-muted-foreground">{o.hint}</span>}
                </span>
                {o.value === value && <Check className="size-3.5 shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
