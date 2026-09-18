/**
 * SPEC 21 — Payment gateway abstraction: public surface.
 * Import providers and the canonical contract from here.
 */
export * from "./types"
export * from "./retry"
export { RazorpayGateway, type RazorpayConfig } from "./razorpay"
export { StripeGateway, type StripeConfig } from "./stripe"
export {
  registerGateway,
  getGateway,
  hasGateway,
  listGateways,
  resetRegistry,
  configureGatewaysFromEnv,
} from "./registry"
