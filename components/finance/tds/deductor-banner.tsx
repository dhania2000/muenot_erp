"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Building2, TriangleAlert } from "lucide-react"

type Deductor = {
  tan: string | null
  pan: string | null
  name: string | null
}

/** Statutory identity of the deductor. Challans, returns and certificates all
 *  quote the TAN, so a missing TAN is surfaced prominently. Data comes from the
 *  read-only /api/finance/tds/deductor reference endpoint. */
export function DeductorBanner() {
  const { data } = useSWR<{ deductor: Deductor }>("/api/finance/tds/deductor", fetcher)
  const d = data?.deductor
  const missingTan = !d?.tan

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{d?.name || "Deductor not configured"}</span>
        </div>
        <IdentityField label="TAN" value={d?.tan} highlightMissing />
        <IdentityField label="PAN" value={d?.pan} />
      </div>
      {missingTan ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No TAN is configured. Deposit challans, quarterly returns and TDS certificates must quote your TAN — set it
            in company settings before filing.
          </span>
        </div>
      ) : null}
    </div>
  )
}

function IdentityField({
  label,
  value,
  highlightMissing,
}: {
  label: string
  value?: string | null
  highlightMissing?: boolean
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`font-mono text-sm ${!value && highlightMissing ? "text-amber-600 dark:text-amber-400" : ""}`}
      >
        {value || "Not set"}
      </span>
    </div>
  )
}
