/**
 * Phase 51 — Settings-driven dropdown values.
 *
 * Central registry of the Recruitment master lists whose dropdown options are
 * configurable from the Recruitment Settings module (`recruitment_settings`)
 * instead of being hardcoded in the module configs.
 *
 * Each entry maps a stable option-set key (referenced by
 * `FieldDef.optionsCategory`) to:
 *   - `category`: the `setting_category` under which the options are stored /
 *      seeded in `recruitment_settings`, and
 *   - `defaults`: the built-in list used to seed that category and as the
 *      fallback whenever no active rows exist yet.
 *
 * The static `options` array still lives on each field as the compile-time
 * fallback, so the forms keep working even before the option-set endpoint
 * responds or when the settings table is empty.
 */

export type RecruitmentOptionSet = {
  /** Settings category (`recruitment_settings.setting_category`). */
  category: string
  /** Built-in options — used to seed the category and as a runtime fallback. */
  defaults: string[]
}

export const RECRUITMENT_OPTION_SETS: Record<string, RecruitmentOptionSet> = {
  employment_type: {
    category: "Employment Type",
    defaults: ["Full Time", "Part Time", "Contract", "Internship", "Freelance", "Temporary"],
  },
  priority: {
    category: "Priority",
    defaults: ["Low", "Medium", "High", "Urgent"],
  },
  work_mode: {
    category: "Work Mode",
    defaults: ["On-site", "Hybrid", "Remote"],
  },
  requisition_status: {
    category: "Requisition Status",
    defaults: ["Open", "On Hold", "Closed", "Cancelled", "Filled"],
  },
  campaign_status: {
    category: "Campaign Status",
    defaults: ["Planned", "Active", "Paused", "Completed", "Cancelled"],
  },
  interview_type: {
    category: "Interview Type",
    defaults: ["Telephonic", "Video", "In-person", "Technical", "HR", "Managerial"],
  },
  interview_mode: {
    category: "Interview Mode",
    defaults: ["Telephonic", "Video", "In-person", "Onsite"],
  },
  interview_result: {
    category: "Interview Result",
    defaults: ["Selected", "On Hold", "Rejected", "Pending"],
  },
  screening_result: {
    category: "Screening Result",
    defaults: ["Shortlisted", "On Hold", "Rejected"],
  },
}

/** Convenience default lists reused directly by the module configs. */
export const EMPLOYMENT_TYPES = RECRUITMENT_OPTION_SETS.employment_type.defaults
export const PRIORITIES = RECRUITMENT_OPTION_SETS.priority.defaults
export const WORK_MODES = RECRUITMENT_OPTION_SETS.work_mode.defaults
