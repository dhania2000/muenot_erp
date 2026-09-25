/**
 * SPEC 19 (req #74) — AI Document Intelligence public surface.
 * Re-exports the model (pure policy), store (tenant-scoped persistence) and
 * service (orchestration) layers so callers import from one place.
 */
export * from "./model"
export * from "./store"
export * from "./extractor"
export {
  intakeExtraction,
  processExtraction,
  reviewExtraction,
  postExtraction,
  type Actor,
  type ServiceResult,
  type ServiceError,
} from "./service"
