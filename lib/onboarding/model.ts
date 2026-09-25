/**
 * Spec32 (#176-179) — First-run onboarding checklist: pure logic.
 * ---------------------------------------------------------------------------
 * No DB / server-only imports so every rule here is unit-tested directly:
 *  - the fixed set of setup steps and their metadata
 *  - progress recalculation: merge live "auto" signals with manual overrides
 *    (done / skipped) into a resolved state, a percent and the next step to
 *    resume from
 *  - applicability filtering so a step whose module is hidden for the tenant is
 *    excluded from both the list and the progress denominator
 */

export class OnboardingError extends Error {
  code: string
  status: number
  constructor(message: string, code = "ONBOARDING_ERROR", status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export const CHECKLIST_STEPS = ["company", "users", "email", "storage", "modules"] as const
export type ChecklistStepKey = (typeof CHECKLIST_STEPS)[number]

/** A user's manual decision for a step. Absent means "let the signal decide". */
export const STEP_OVERRIDES = ["done", "skipped", "todo"] as const
export type StepOverrideInput = (typeof STEP_OVERRIDES)[number]
export type StepOverride = "done" | "skipped"

/** Resolved state after merging the live signal with any manual override. */
export type StepState = "todo" | "done" | "skipped"

export type StepMeta = {
  key: ChecklistStepKey
  title: string
  description: string
  /** Where "Set up" takes the user. */
  href: string
  /** Optional permission slug that also controls whether the step is relevant. */
  feature?: string
}

export const STEP_META: Record<ChecklistStepKey, StepMeta> = {
  company: {
    key: "company",
    title: "Add your company details",
    description: "Set your company name, logo and address so documents and emails are branded.",
    href: "/admin/settings/company",
    feature: "settings.company",
  },
  users: {
    key: "users",
    title: "Invite your team",
    description: "Add the people who will use the workspace and assign their roles.",
    href: "/modules/hr/employees",
    feature: "hr.view_employees",
  },
  email: {
    key: "email",
    title: "Connect email",
    description: "Configure sending so invoices, letters and notifications reach recipients.",
    href: "/admin/settings/email",
    feature: "settings.email",
  },
  storage: {
    key: "storage",
    title: "Set up file storage",
    description: "Choose where uploaded documents and attachments are stored.",
    href: "/admin/settings/storage",
    feature: "settings.storage",
  },
  modules: {
    key: "modules",
    title: "Enable modules & permissions",
    description: "Turn on the modules your team needs and grant access to them.",
    href: "/admin/permissions",
    feature: "settings.permissions",
  },
}

export function isChecklistStep(v: unknown): v is ChecklistStepKey {
  return typeof v === "string" && (CHECKLIST_STEPS as readonly string[]).includes(v)
}

export function normalizeOverride(v: unknown): StepOverrideInput {
  if (typeof v !== "string" || !(STEP_OVERRIDES as readonly string[]).includes(v)) {
    throw new OnboardingError("state must be one of: done, skipped, todo", "INVALID_STATE")
  }
  return v as StepOverrideInput
}

export type ComputedStep = StepMeta & {
  /** True when the live signal reports this step already satisfied. */
  auto: boolean
  /** The stored manual override, if any. */
  override: StepOverride | null
  /** Final resolved state used for display and progress. */
  state: StepState
}

export type ComputedChecklist = {
  steps: ComputedStep[]
  total: number
  completed: number
  percent: number
  complete: boolean
  dismissed: boolean
  /** First unresolved step so the UI can resume where the user left off. */
  nextStep: ChecklistStepKey | null
}

export type ComputeInput = {
  /** Live detection per step (e.g. company.name is set). */
  signals: Partial<Record<ChecklistStepKey, boolean>>
  /** Stored manual overrides per step. */
  overrides: Partial<Record<ChecklistStepKey, StepOverride>>
  dismissed?: boolean
  /**
   * Which steps apply to this tenant. Defaults to all. A step left out here
   * (e.g. its module is hidden) is excluded from the list AND the denominator.
   */
  applicable?: readonly ChecklistStepKey[]
}

/**
 * Recalculate the checklist from scratch. A step is "done" when either its live
 * signal fires or the user marked it done; "skipped" when explicitly skipped
 * (which still counts as resolved so it never blocks completion); otherwise
 * "todo". Percent and next-step are derived only from applicable steps.
 */
export function computeChecklist(input: ComputeInput): ComputedChecklist {
  const applicable = (input.applicable ?? CHECKLIST_STEPS).filter(isChecklistStep)
  const order = CHECKLIST_STEPS.filter((k) => applicable.includes(k))

  const steps: ComputedStep[] = order.map((key) => {
    const auto = Boolean(input.signals[key])
    const override = input.overrides[key] ?? null
    let state: StepState
    if (override === "skipped") state = "skipped"
    else if (auto || override === "done") state = "done"
    else state = "todo"
    return { ...STEP_META[key], auto, override, state }
  })

  const total = steps.length
  const completed = steps.filter((s) => s.state !== "todo").length
  const percent = total === 0 ? 100 : Math.round((completed / total) * 100)
  const nextStep = steps.find((s) => s.state === "todo")?.key ?? null

  return {
    steps,
    total,
    completed,
    percent,
    complete: total > 0 && completed === total,
    dismissed: Boolean(input.dismissed),
    nextStep,
  }
}

/** Parse the persisted overrides JSON defensively into a typed map. */
export function parseOverrides(raw: unknown): Partial<Record<ChecklistStepKey, StepOverride>> {
  let obj: Record<string, unknown> | null = null
  if (raw && typeof raw === "object" && !Array.isArray(raw)) obj = raw as Record<string, unknown>
  else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed
    } catch {
      obj = null
    }
  }
  const out: Partial<Record<ChecklistStepKey, StepOverride>> = {}
  if (!obj) return out
  for (const key of CHECKLIST_STEPS) {
    const v = obj[key]
    if (v === "done" || v === "skipped") out[key] = v
  }
  return out
}
