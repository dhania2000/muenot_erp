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
