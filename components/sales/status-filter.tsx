"use client"

import { useRouter, usePathname, useSearchParams } from "next/navigation"

export function StatusFilter({ statuses }: { statuses: string[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const current = params.get("status") ?? "all"

  function onChange(value: string) {
    const next = new URLSearchParams(Array.from(params.entries()))
    if (value === "all") next.delete("status")
    else next.set("status", value)
    router.replace(`${pathname}?${next.toString()}`)
  }

  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Filter by status"
      className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <option value="all">All statuses</option>
      {statuses.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  )
}
