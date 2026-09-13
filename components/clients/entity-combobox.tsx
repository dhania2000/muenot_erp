"use client"

import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Loader2, Search, X } from "lucide-react"

export type ComboOption = { value: string; label: string; sub?: string; data?: Record<string, any> }

/**
 * Minimal search-select combobox. No external popover primitive is available in
 * this project, so the results render in an absolutely-positioned panel under
 * the input (a standard combobox pattern). Selecting an option carries its
 * stable `value` (an id) back to the caller for relational linking.
 */
export function EntityCombobox({
  selectedLabel,
  placeholder,
  disabled,
  emptyText = "No matches",
  onSearch,
  onSelect,
  onClear,
}: {
  selectedLabel: string | null
  placeholder: string
  disabled?: boolean
  emptyText?: string
  onSearch: (q: string) => Promise<ComboOption[]>
  onSelect: (option: ComboOption) => void
  onClear?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [options, setOptions] = useState<ComboOption[]>([])
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!open) return
    const id = ++seq.current
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await onSearch(q)
        if (id === seq.current) setOptions(res)
      } finally {
        if (id === seq.current) setLoading(false)
      }
    }, 200)
    return () => clearTimeout(t)
  }, [q, open, onSearch])

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [])

  if (selectedLabel) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <span className="flex-1 truncate text-sm">{selectedLabel}</span>
        {onClear && !disabled && (
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}>
            <X className="size-4" />
          </Button>
        )}
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="relative">
      <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
      <Input
        className="pl-9"
        placeholder={placeholder}
        value={q}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
      />
      {open && (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Searching…
            </div>
          )}
          {!loading && options.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</div>
          )}
          {!loading &&
            options.map((o) => (
              <button
                key={o.value}
                type="button"
                className="flex w-full flex-col items-start rounded-sm px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  onSelect(o)
                  setOpen(false)
                  setQ("")
                }}
              >
                <span className="font-medium">{o.label}</span>
                {o.sub && <span className="text-xs text-muted-foreground">{o.sub}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
