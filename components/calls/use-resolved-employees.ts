"use client"

import useSWR from "swr"

/** A loosely-linked directory identifier from a non-HR module (Operations). */
export type ResolveItem = {
  /** Stable key used to read the result back (e.g. the row id). */
  key: string
  /** Numeric hr_employees.id, if the row already has one. */
  id?: string | number | null
  /** Employee code or numeric id stored on the row (e.g. operations_resources.employee_id). */
  code?: string | number | null
  /** Official/personal email to match on. */
  email?: string | null
  /** Display name to match on (only used when it maps to exactly one employee). */
  name?: string | null
  /** operations_resources.id — resolved server-side to its employee link. */
  resourceId?: string | number | null
}

export type ResolvedEmployee = {
  employeeId: number
  name: string
  active: boolean
  hasLogin: boolean
}

async function resolveFetcher(items: ResolveItem[]): Promise<Record<string, ResolvedEmployee | null>> {
  const res = await fetch("/api/calls/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  })
  if (!res.ok) return {}
  const data = await res.json()
  return (data?.resolved || {}) as Record<string, ResolvedEmployee | null>
}

/**
 * Batch-resolve loosely-linked module identifiers (Operations Resources,
 * Allocations, Tasks) into callable HR Employee Master ids. Returns a map keyed
 * by each item's `key`. Rows that cannot be matched (vendors, agencies, no HR
 * record) resolve to null and should render no call action.
 */
export function useResolvedEmployees(items: ResolveItem[]) {
  // Only send items that carry at least one usable identifier.
  const usable = items.filter(
    (it) => it.id != null || it.code != null || it.email != null || it.name != null || it.resourceId != null,
  )
  // A stable cache key so SWR dedupes identical lookups across renders.
  const cacheKey = usable.length ? `resolve:${JSON.stringify(usable)}` : null
  const { data } = useSWR(cacheKey, () => resolveFetcher(usable), {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
  })
  return (data || {}) as Record<string, ResolvedEmployee | null>
}
