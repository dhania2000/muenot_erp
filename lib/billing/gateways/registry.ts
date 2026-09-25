import type { PaymentGateway } from "./types"
import { RazorpayGateway } from "./razorpay"
import { StripeGateway } from "./stripe"
import { PayUGateway } from "./payu"
import { CashfreeGateway } from "./cashfree"

/**
 * Gateway registry (Phase 2/3).
 * ---------------------------------------------------------------------------
 * The single lookup the billing layer uses to reach a provider by name. Adding
 * a new provider is: implement `PaymentGateway`, then `registerGateway(...)`.
 * Callers depend on the interface, never on a concrete adapter — so business
 * code stays provider-agnostic.
 */

const registry = new Map<string, PaymentGateway>()

export function registerGateway(gateway: PaymentGateway): void {
  registry.set(gateway.name.toLowerCase(), gateway)
}

export function hasGateway(name: string): boolean {
  return registry.has(String(name).toLowerCase())
}

export function getGateway(name: string): PaymentGateway {
  const gateway = registry.get(String(name).toLowerCase())
  if (!gateway) {
    throw new Error(
      `Payment gateway "${name}" is not configured. Configure its credentials (see configureGatewaysFromEnv) or registerGateway() it.`,
    )
  }
  return gateway
}

export function listGateways(): string[] {
  return [...registry.keys()]
}

/** Clear the registry — test hook only. */
export function resetRegistry(): void {
  registry.clear()
}

let configuredFromEnv = false

/**
 * Register the providers whose credentials are present in the environment.
 * Idempotent, so routes can call it defensively on every request. A provider
 * with no credentials is simply absent from the registry — `getGateway` then
 * fails loudly rather than charging through a half-configured adapter.
 */
export function configureGatewaysFromEnv(env: NodeJS.ProcessEnv = process.env, force = false): string[] {
  if (configuredFromEnv && !force) return listGateways()

  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    registerGateway(
      new RazorpayGateway({
        keyId: env.RAZORPAY_KEY_ID,
        keySecret: env.RAZORPAY_KEY_SECRET,
        webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? "",
      }),
    )
  }

  if (env.STRIPE_SECRET_KEY) {
    registerGateway(
      new StripeGateway({
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
        publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
        apiBase: env.STRIPE_API_BASE,
      }),
    )
  }

  if (env.PAYU_MERCHANT_KEY && env.PAYU_MERCHANT_SALT) {
    registerGateway(
      new PayUGateway({
        merchantKey: env.PAYU_MERCHANT_KEY,
        merchantSalt: env.PAYU_MERCHANT_SALT,
        apiBase: env.PAYU_API_BASE,
        successUrl: env.PAYU_SUCCESS_URL,
        failureUrl: env.PAYU_FAILURE_URL,
      }),
    )
  }

  if (env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY) {
    registerGateway(
      new CashfreeGateway({
        appId: env.CASHFREE_APP_ID,
        secretKey: env.CASHFREE_SECRET_KEY,
        apiBase: env.CASHFREE_API_BASE,
        apiVersion: env.CASHFREE_API_VERSION,
        returnUrl: env.CASHFREE_RETURN_URL,
        toleranceSeconds: env.CASHFREE_WEBHOOK_TOLERANCE_SECONDS
          ? Number(env.CASHFREE_WEBHOOK_TOLERANCE_SECONDS)
          : undefined,
      }),
    )
  }

  configuredFromEnv = true
  return listGateways()
}
