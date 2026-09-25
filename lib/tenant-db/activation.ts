import type { DeploymentModel } from "./model"

/**
 * The ERP business repositories still use the global shared pool. The existing
 * isolated-pool router is used by infrastructure probes, not by those
 * repositories. Until the data-access migration is complete, changing a live
 * tenant's hosting mode would split or leak its business data.
 */
export class HostingModeNotReadyError extends Error {
  readonly code = "HOSTING_MODE_NOT_READY"
  readonly status = 409

  constructor() {
    super("Isolated tenant data hosting is not available for activation yet.")
    this.name = "HostingModeNotReadyError"
  }
}

export function assertSafeHostingModeCreate(model: DeploymentModel): void {
  if (model !== "shared_database") throw new HostingModeNotReadyError()
}

export function assertSafeHostingModeUpdate(current: DeploymentModel, next: DeploymentModel): void {
  if (current !== next) throw new HostingModeNotReadyError()
}
