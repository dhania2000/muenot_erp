"use client"

import { CallDialer as SharedCallDialer, type CallTarget } from "@/components/shared/call-dialer"

export type { CallTarget }

/** Sales dialer — thin wrapper over the shared dialer, wired to the Sales calling API. */
export function CallDialer(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: CallTarget | null
  onLogged?: () => void
}) {
  return (
    <SharedCallDialer
      {...props}
      apiBase="/api/sales/calls"
      subjectKey="lead_id"
      title={props.target?.name ? `Call ${props.target.name}` : "Call lead"}
    />
  )
}
