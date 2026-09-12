// Shared, client-safe presentation helpers for the rotation domain UI.

export type RotationState = "Running" | "Scheduled" | "Ended"

const todayISO = () => new Date().toISOString().slice(0, 10)

/** Derive the human lifecycle state of a rotation from its status + dates. */
export function rotationState(rot: {
  status?: string
  effective_from?: string | null
  effective_until?: string | null
}): RotationState {
  const today = todayISO()
  const from = rot.effective_from ? String(rot.effective_from).slice(0, 10) : null
  const until = rot.effective_until ? String(rot.effective_until).slice(0, 10) : null
  if (rot.status !== "Active" || (until && until < today)) return "Ended"
  if (from && from > today) return "Scheduled"
  return "Running"
}

/** Badge variant for a rotation lifecycle state. */
export function stateVariant(state: RotationState): "default" | "secondary" | "outline" | "destructive" {
  if (state === "Running") return "default"
  if (state === "Scheduled") return "secondary"
  return "outline"
}
