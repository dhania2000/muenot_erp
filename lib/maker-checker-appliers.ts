import "server-only"
import { registerApplier, type ApplyContext } from "./maker-checker"
import { recordPayment, type RecordPaymentInput } from "./finance-payments"

// =============================================================================
// Maker-Checker · appliers.
// -----------------------------------------------------------------------------
// The mutations that run *after* a captured high-risk change is approved. Each
// applier receives the exact payload the maker prepared and performs the real
// business operation. Kept in a dedicated module (lazily imported by
// maker-checker.ts) so the framework never statically depends on business
// services — this is the one place the two are wired together.
//
// To gate a new operation end to end: (1) add it to maker-checker-registry.ts,
// (2) capture its payload with submitForApproval at the module route, and
// (3) register the mutation here.
// =============================================================================

// finance.payment.create — the maker prepares a receipt; it only touches the
// ledger once a checker approves. The maker's user id is preserved as the
// payment's author so accountability points at who prepared it.
registerApplier("finance.payment.create", async (payload: RecordPaymentInput, ctx: ApplyContext) => {
  const res = await recordPayment({ ...payload, created_by: ctx.makerId ?? payload.created_by ?? null })
  return { ref: res?.payment_id ? String(res.payment_id) : null }
})
