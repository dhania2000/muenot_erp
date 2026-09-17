import { esignStatusTone, signerStatusTone } from "@/lib/legal-esign-shared"

const TONE_CLASSES: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-700 ring-emerald-600/20",
  blue: "bg-sky-100 text-sky-700 ring-sky-600/20",
  amber: "bg-amber-100 text-amber-800 ring-amber-600/20",
  red: "bg-rose-100 text-rose-700 ring-rose-600/20",
  slate: "bg-slate-100 text-slate-700 ring-slate-600/20",
}

export function EsignStatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = TONE_CLASSES[esignStatusTone(status)]
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone} ${className ?? ""}`}
    >
      {status}
    </span>
  )
}

export function SignerStatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = TONE_CLASSES[signerStatusTone(status)]
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone} ${className ?? ""}`}
    >
      {status}
    </span>
  )
}
