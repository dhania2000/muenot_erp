/**
 * SPEC 86 — Document Management System public surface.
 * Re-exports the model logic, shared types, schema self-heal and store so
 * routes/UI import from a single "@/lib/dms" entry point.
 */
export * from "./model"
export * from "./types"
export { ensureDmsSchema } from "./schema"
export * from "./store"
export * from "./integration"
