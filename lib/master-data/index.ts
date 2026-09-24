/**
 * SPEC 90 — Centralized Master Data public surface.
 * Modules import canonical masters from a single "@/lib/master-data" entry
 * point instead of re-defining or hard-coding reference lists.
 */
export * from "./types"
export { MASTER_SOURCES, MASTER_KINDS, getMasterSource } from "./registry"
export { ensureMasterDataSchema } from "./schema"
export {
  listMaster,
  getMaster,
  isValidMasterRef,
  upsertMaster,
  deactivateMaster,
  type ListOptions,
  type UpsertInput,
} from "./service"

// SPEC 91 — Master Data Governance
export {
  GOV_STATUSES,
  GOV_ACTIONS,
  GOVERNED_KINDS,
  isGovernedKind,
  canTransition,
  allowedTransitions,
  resolvedStatusForAction,
  validateActionForStatus,
  evaluateApprovalAuthority,
  isEffectiveNow,
  statusLabel,
  type GovStatus,
  type GovAction,
  type GovDecision,
  type ChangeRequestStatus,
} from "./governance-model"
export { ensureGovernanceSchema } from "./governance-schema"
export {
  getGovernance,
  listGovernance,
  listChangeRequests,
  getHistory,
  setOwnership,
  submitChangeRequest,
  approveChangeRequest,
  rejectChangeRequest,
  type GovRecord,
  type ChangeRequest,
  type HistoryEntry,
  type SubmitInput,
} from "./governance"
